"""
Rewind — Query engine
Owner: Jossue

Run:   python query.py "where did I leave my keys"
Deps:  anthropic, httpx, python-dotenv

Goal: `query("where are my keys")` returns a coherent JSON answer against a
mock or real event log. K2 primary, Claude 4.7 failover from day one.

Demo-robustness notes:
- LLMs sometimes wrap JSON in prose or markdown fences. `_extract_json` tries
  direct parse, then fences, then a regex for the first {...} block.
- If Claude's first response doesn't parse, one repair retry asks for JSON only.
- If everything fails, `_SAFE_FALLBACK` returns a valid-shape "I didn't see
  that happen." so the frontend never crashes on a bad demo moment.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from anthropic import Anthropic
from dotenv import load_dotenv

from observability import get_logger

load_dotenv()
_LOG = get_logger()

DB_PATH = Path("rewind.db")
RECENT_EVENTS_LIMIT = 80
K2_ENDPOINT = os.getenv("K2_ENDPOINT", "")
K2_API_KEY = os.getenv("K2_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# Demo-day safety dial. When set to any truthy value:
#   - K2 is skipped entirely (Claude-only path, no failover dance)
#   - Claude per-call timeout is tightened so worst-case-to-fallback
#     stays under the demo-moment latency budget.
# The banner + /health aren't altered — honest reporting stands.
# See PLAN.md §Phase C "Two env flags, independent." FIXTURE_MODE is
# deliberately separate; flipping DEMO_MODE doesn't imply fake data.
REWIND_DEMO_MODE = os.getenv("REWIND_DEMO_MODE", "").strip().lower() in ("1", "true", "yes", "on")


def k2_configured() -> bool:
    """True when K2_ENDPOINT + K2_API_KEY look like real values.

    Guards against the common footgun where someone copies .env.example
    into .env and leaves the placeholder values (``...``) intact — without
    this check, the truthy non-empty strings would make the backend think
    K2 is primary, route every query through it, and fast-fail on every
    request. The banner + /health + /query routing would all lie about
    what model is actually answering.
    """
    if not (K2_ENDPOINT and K2_API_KEY):
        return False
    if "..." in K2_ENDPOINT or "..." in K2_API_KEY:
        return False
    return True

CLAUDE_MODEL = "claude-opus-4-7"
# K2 Think V2 model slug per the MBZUAI API:
#   POST https://api.k2think.ai/v1/chat/completions
#   body.model = "MBZUAI-IFM/K2-Think-v2"
# OpenAI-shaped request/response (choices[0].message.content carries the text).
K2_MODEL = "MBZUAI-IFM/K2-Think-v2"

SYSTEM_PROMPT = """You are the reasoning layer of Rewind, an on-device episodic-memory system for a physical space. You receive a structured event log and a user query.

Answer from what the log shows. **Partial information is a valid answer** — when the log has events related to the question but doesn't fully resolve it, report what you saw AND what's uncertain. Examples:
- "Where are my keys?" + log shows pickup but no placement → "You picked up your keys at 9:27 AM from the desk; I haven't seen where you set them down since."
- "Did I take my pills this morning?" + log shows a taking_pills action → "Yes, you took your pills around 4:28 AM."
- "What's on the desk right now?" + log shows object_placed events on the desk with no matching picked_up → list them by time.

Only respond with exactly "I didn't see that happen." when the log contains **no events relevant to the question at all** (e.g., a question about a laptop when no laptop-related events exist).

Never invent events. Include specific times. Keep the warm, roommate-ish tone. Answers must be under 2 sentences.

Respond in JSON only: {"answer": string, "confidence": "high"|"medium"|"low", "event_ids": [int, ...]}. Populate event_ids with every event id you actually used to form the answer."""

_SAFE_FALLBACK: dict[str, Any] = {
    "answer": "I didn't see that happen.",
    "confidence": "low",
    "event_ids": [],
}

# Per-call timeouts, picked so worst-case total to safe-fallback stays bounded.
# See CONTRACTS.md §3c timeouts for the full budget discussion.
# DEMO_MODE tightens Claude's timeout so the demo-moment latency cap holds
# even if the network has a bad second.
# K2 Think V2 is a reasoning model — cold-start inference is noticeably slower
# than Claude's. 12s accommodates first-call warmup; subsequent calls usually
# land in 2–5s.
K2_TIMEOUT_S = 12.0
# K2 Think V2 is a reasoning model — it often emits chain-of-thought before
# the final JSON answer. Give it enough budget for both; our _extract_json
# finds the final JSON block regardless. 400 tokens truncated mid-reasoning
# on some prompts in testing.
K2_MAX_TOKENS = 800
CLAUDE_TIMEOUT_S = 6.0 if REWIND_DEMO_MODE else 10.0


def _fallback(model_tag: str = "fallback") -> dict[str, Any]:
    """Build a fresh copy of the safe fallback with `_model` set."""
    return {**_SAFE_FALLBACK, "_model": model_tag}


@dataclass
class EventRow:
    id: int
    ts: float
    event_type: str
    object: str
    # Spatial grounding — e.g. "the desk". None when capture.py didn't
    # resolve a surface, or when reading from a pre-spatial rewind.db.
    location: str | None = None


def load_recent_events(db_path: Path = DB_PATH, limit: int = RECENT_EVENTS_LIMIT) -> list[EventRow]:
    if not db_path.exists():
        return _mock_events()
    conn = sqlite3.connect(db_path)
    # Pre-spatial rewind.db files don't have a `location` column yet; select
    # NULL in that slot so the EventRow tuple shape is stable.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(events)")}
    loc_col = "location" if "location" in cols else "NULL"
    rows = conn.execute(
        f"SELECT id, ts, event_type, object, {loc_col} FROM events "
        f"ORDER BY ts DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [EventRow(*r) for r in reversed(rows)]


def _mock_events() -> list[EventRow]:
    """Synthetic events covering the three demo scenarios.

    Anchored to relative offsets from `now` so the timeline is always
    coherent regardless of what time the demo runs:
      - morning meds: ~9 hours ago (pill bottle on desk → taking_pills)
      - person traffic: ~6 hours ago
      - keys picked up: ~4 hours ago (from the desk)
      - book placed on the chair: ~2 hours ago
      - judge places phone: ~3 minutes ago (on the desk)
      - person leaves: ~1 minute ago

    Taxonomy matches pi/capture.py after the spatial-grounding rework:
      - HERO_OBJECTS: cell phone, bottle (pill bottle), remote (keys), book, person
      - ACTION_RULES: taking_pills, using_phone, reading
      - location: resolved against SURFACES = {dining table, chair}

    Returned in chronological order (oldest first) to match how
    `load_recent_events` delivers real rows to `format_log`.
    """
    now = datetime.now().timestamp()
    return [
        EventRow(1, now - 9 * 3600,        "object_placed",    "bottle",       "the desk"),   # pill bottle on desk
        EventRow(2, now - 9 * 3600 + 60,   "action_detected",  "taking_pills"),               # actually took them
        EventRow(3, now - 6 * 3600,        "person_entered",   "person"),
        EventRow(4, now - 6 * 3600 + 60,   "person_left",      "person"),
        EventRow(5, now - 4 * 3600,        "object_picked_up", "remote",       "the desk"),   # keys from desk
        EventRow(6, now - 2 * 3600,        "object_placed",    "book",         "the chair"),  # book on chair
        EventRow(7, now - 180,             "object_placed",    "cell phone",   "the desk"),   # phone on desk
        EventRow(8, now - 60,              "person_left",      "person"),
    ]


# Translation layer between CV labels and user-facing names.
# The CV pipeline is stuck with COCO's vocabulary, which is missing the things
# we actually demo (keys, pill bottle). Sunghoo picked visually-similar COCO
# classes as stand-ins. Translating here — at the query-context assembly seam,
# AFTER capture.py's schema and BEFORE events reach the LLM — means the CV
# contract stays stable and the user never hears "scissors" in an answer about
# their medication.
#
# Do NOT rewrite labels at the ingestion layer (that would violate the
# capture.py ⇄ rewind.db ⇄ backend contract). Translate at the seam only.
# Keyed on pi/capture.py's HERO_OBJECTS after the spatial-grounding rework.
# "bottle" is now the single stand-in for the pill bottle (COCO has no pill
# class; `scissors` and `cup` are no longer hero objects). "remote" remains
# the stand-in for keys. Unknown labels fall through untranslated, so
# future hero additions (e.g. "cell phone" → "phone") can be added here
# without touching callers.
DISPLAY_LABELS: dict[str, str] = {
    "bottle":    "pill bottle",
    "remote":    "keys",
    "book":      "notebook",
}


def _display_label(raw: str) -> str:
    return DISPLAY_LABELS.get(raw, raw)


def humanize_timestamp(ts: float, now: float) -> str:
    """Render an event timestamp as a human-spoken phrase.

    Bucketed per prompt_debt.md (2026-04-18 02:43 · absolute time):
      < 90 s           : "a moment ago"
      < 1 hour         : "N minutes ago"
      same calendar day: "earlier today around HH AM/PM"
      prior day        : "yesterday around HH AM/PM"
      older            : "N days ago"

    The LLM still receives the absolute timestamp alongside this relative
    phrase (see ``format_log``) so it can choose specificity when the context
    warrants — e.g. medication timing wants "8:02 AM", not "earlier today".
    Natural-language context (say-it-aloud) wants relative.
    """
    dt_now = datetime.fromtimestamp(now)
    dt_ev  = datetime.fromtimestamp(ts)
    delta_s = now - ts

    if delta_s < 0:
        # Future events shouldn't exist, but don't crash if clocks disagree.
        return "just now"
    if delta_s < 90:
        return "a moment ago"
    if delta_s < 3600:
        mins = int(delta_s // 60)
        return f"{mins} minute{'s' if mins != 1 else ''} ago"

    # Hour-rounded phrasing for same-day and yesterday needs a friendly AM/PM.
    hour_phrase = dt_ev.strftime("%I %p").lstrip("0").lower().replace(" am", " AM").replace(" pm", " PM")

    if dt_ev.date() == dt_now.date():
        return f"earlier today around {hour_phrase}"
    if (dt_now.date() - dt_ev.date()).days == 1:
        return f"yesterday around {hour_phrase}"

    days = (dt_now.date() - dt_ev.date()).days
    return f"{days} day{'s' if days != 1 else ''} ago"


def format_log(events: list[EventRow]) -> str:
    """Serialize events for the LLM. Each line carries both an absolute
    timestamp (for clinical specificity, e.g. medication timing) and a
    relative phrase (for natural spoken answers). The prompt leaves the
    choice to the model.

    Spatial grounding: when ``location`` is present (e.g. "the desk"),
    append "on the desk" to the line so the model can cite where an object
    was placed or picked up. Location is only meaningful for object events
    — never rendered on person/action events.
    """
    lines = []
    now = datetime.now().timestamp()
    for e in events:
        tstr = datetime.fromtimestamp(e.ts).strftime("%H:%M:%S")
        rel  = humanize_timestamp(e.ts, now)
        obj  = _display_label(e.object)
        loc  = f" on {e.location}" if e.location else ""
        lines.append(f"[id={e.id}] [{tstr} · {rel}] {e.event_type}: {obj}{loc}")
    return "\n".join(lines)


def _log(tag: str, msg: str, level: str = "info") -> None:
    """Route query-engine events through the structured logger.

    ``level`` maps to PLAN.md's three-level split:
      info  — request received/answered, model used.
      warn  — fallback triggered, K2 failover, repair-retry used, slow request.
      error — safe fallback actually served, unrecoverable exception.
    """
    fn = getattr(_LOG, level if level != "warn" else "warning", _LOG.info)
    fn("[%s] %s", tag, msg)


def _iter_balanced_json_blocks(text: str):
    """Yield every top-level ``{...}`` substring in ``text`` using brace balance.

    Reasoning models like K2 Think V2 emit chain-of-thought *before* (and
    sometimes *after*) the final JSON answer. A naive greedy regex
    (``{.*}`` with DOTALL) can span across multiple unrelated JSON blocks
    and produce an unparseable concatenation. This scanner walks the text
    character-by-character, tracks string escapes, and yields each complete
    brace-balanced block so callers can try them individually.
    """
    depth = 0
    start = -1
    in_string = False
    escape = False
    for i, c in enumerate(text):
        if escape:
            escape = False
            continue
        if c == "\\":
            escape = True
            continue
        if c == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if c == "{":
            if depth == 0:
                start = i
            depth += 1
        elif c == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    yield text[start : i + 1]
                    start = -1


def _extract_json(text: str) -> dict:
    """Pull a JSON answer object out of an LLM response, even when the model
    emits reasoning prose, markdown fences, or multiple JSON blocks.

    Strategy ladder:
      1. Direct ``json.loads`` — works when the model obeyed "JSON only."
      2. Strip ```json / ``` fences, retry direct parse.
      3. Brace-balanced scan: try every top-level ``{...}`` block in order.
         Prefer the *last* one that has an ``"answer"`` field (reasoning
         models often emit scratch JSON first, final answer last).
      4. Fall back to greedy regex for pathological cases.

    Raises ValueError if nothing parses.
    """
    s = text.strip()

    # 1. Direct parse
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    # 2. Strip markdown fences and retry
    fenced = re.sub(r"```(?:json)?\s*", "", s).replace("```", "").strip()
    try:
        obj = json.loads(fenced)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    # 3. Brace-balanced scan — find candidates, prefer those with "answer"
    answer_shaped: list[dict] = []
    other_dicts:   list[dict] = []
    for block in _iter_balanced_json_blocks(fenced):
        try:
            obj = json.loads(block)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        if "answer" in obj:
            answer_shaped.append(obj)
        else:
            other_dicts.append(obj)
    if answer_shaped:
        # Prefer the last answer-shaped block — reasoning models typically
        # produce scratch JSON before the final answer.
        return answer_shaped[-1]
    if other_dicts:
        return other_dicts[-1]

    # 4. Greedy regex as last resort
    match = re.search(r"\{.*\}", fenced, re.DOTALL)
    if match:
        try:
            obj = json.loads(match.group(0))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass

    raise ValueError(f"no JSON object found in response: {text[:300]!r}")


def _validate_answer(obj: dict) -> dict:
    """Ensure the LLM response matches the contract the frontend expects."""
    if not isinstance(obj, dict):
        raise ValueError(f"expected dict, got {type(obj).__name__}")
    if "answer" not in obj or not isinstance(obj["answer"], str):
        raise ValueError("missing or non-string 'answer'")
    obj.setdefault("confidence", "medium")
    obj.setdefault("event_ids", [])
    return obj


def call_k2(log_text: str, question: str) -> dict | None:
    """K2 Think V2 primary path. Returns None on any failure so the caller falls back.

    Hardened against common reasoning-model + OpenAI-compat-fork quirks
    that other HackPrinceton teams reported fighting with:

      - **No ``response_format``.** Many OpenAI-compatible forks (K2 included,
        based on observed 400s) reject or misinterpret this OpenAI-specific
        parameter. We enforce JSON output via the prompt instead.

      - **System prompt inlined in the user turn.** Reasoning models handle
        the `system` role inconsistently across forks — some ignore it, some
        reject multi-message arrays. A single user turn with the instruction
        up front and the "JSON only" reminder at the end is the most
        portable shape.

      - **max_tokens cap.** Prevents runaway chain-of-thought from truncating
        the final JSON block we actually care about.

      - **Non-200 body surfaced to log.** Instead of just "HTTP 400",
        ``rewind.log`` gets the first 200 chars of the server's error
        message, making it one-look diagnosable ("invalid model",
        "rate limited", "auth"). Saves 20 minutes of flail.

      - **Reasoning-model output tolerated.** ``_extract_json`` scans for
        brace-balanced blocks and prefers the last one with an "answer"
        field, so K2's habit of emitting scratch-work JSON before the final
        answer no longer defeats extraction.

      - **Timeout raised to ``K2_TIMEOUT_S = 12s``.** First-call cold-start
        on K2 can take 8–10s; warm calls are 2–5s. Claude fallback still
        catches anything beyond that.
    """
    if not k2_configured():
        return None

    # Prompt is one user turn. Instruction first, data in the middle,
    # "JSON only" reminder last — last-line emphasis survives even if the
    # model goes off on a reasoning tangent. The CRITICAL line at the end
    # is deliberately shouty — K2 Think V2's default behavior is to emit
    # "We need to parse the event log..." style reasoning; plain "JSON only"
    # wasn't enough in testing.
    prompt = (
        f"{SYSTEM_PROMPT}\n\n"
        f"Event log:\n{log_text}\n\n"
        f"Query: {question}\n\n"
        f"CRITICAL OUTPUT FORMAT: Your entire response must be a single JSON "
        f"object, nothing else. Start with `{{` and end with `}}`. Do NOT write "
        f"'We need to...', 'Let me think...', 'First I see...', or any other "
        f"reasoning prose. Do NOT use markdown fences. Example of a valid "
        f'response shape: {{"answer": "You placed your keys on the desk at '
        f'9:27 AM.", "confidence": "high", "event_ids": [5]}}'
    )

    try:
        r = httpx.post(
            K2_ENDPOINT,
            json={
                "model":       K2_MODEL,
                "messages":    [{"role": "user", "content": prompt}],
                "temperature": 0.2,
                "max_tokens":  K2_MAX_TOKENS,
            },
            headers={"Authorization": f"Bearer {K2_API_KEY}"},
            timeout=K2_TIMEOUT_S,
        )
    except httpx.TimeoutException:
        _log("k2", f"timeout after {K2_TIMEOUT_S}s → falling back to Claude", "warn")
        return None
    except Exception as exc:
        _log("k2", f"request error ({type(exc).__name__}): {exc} → falling back to Claude", "warn")
        return None

    if r.status_code != 200:
        # Surface a slice of the actual response body — one-look debugging
        # instead of "HTTP 400" staring at you with no context.
        body_preview = (r.text or "")[:200].replace("\n", " ")
        _log("k2", f"HTTP {r.status_code} body={body_preview!r} → falling back to Claude", "warn")
        return None

    try:
        data = r.json()
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as exc:
        _log("k2", f"unexpected response shape ({exc}) → falling back to Claude", "warn")
        return None

    try:
        result = _validate_answer(_extract_json(content))
    except ValueError as exc:
        # Log content length + first 200 chars so we can tell truncation
        # ("emitted 800 chars of reasoning and got cut off") vs genuinely
        # non-JSON output ("emitted 80 chars that aren't JSON").
        content_str = content or ""
        preview = content_str[:200].replace("\n", " ")
        _log(
            "k2",
            f"JSON extraction failed ({exc}) "
            f"content[len={len(content_str)}]={preview!r} → falling back to Claude",
            "warn",
        )
        return None

    return result


def call_claude(log_text: str, question: str) -> dict:
    """Claude 4.7 failover path. Always returns a validated answer with `_model` set.

    Flow:
      1. First call. If it returns valid JSON → done, `_model: claude-opus-4-7`.
      2. If first call returns bad JSON → one repair retry with "JSON only" nudge.
      3. If the first call raises (timeout / network / rate limit) → skip repair
         and go straight to safe fallback. Don't burn a second timeout when the
         connection is already misbehaving.
      4. Any terminal failure → safe fallback, `_model: fallback`.
    """
    if not ANTHROPIC_API_KEY:
        # ERROR: safe fallback is actually being served to the user.
        _log("claude", "ANTHROPIC_API_KEY missing → safe fallback", "error")
        return _fallback()

    client = Anthropic(api_key=ANTHROPIC_API_KEY, timeout=CLAUDE_TIMEOUT_S)
    user_msg = f"Event log:\n{log_text}\n\nQuery: {question}"

    # Attempt 1
    first_text = ""
    first_returned = False
    try:
        resp = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=400,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )
        first_text = "".join(b.text for b in resp.content if b.type == "text")
        first_returned = True
        try:
            result = _validate_answer(_extract_json(first_text))
            result["_model"] = CLAUDE_MODEL
            _log("claude", "ok")
            return result
        except ValueError:
            # WARN: repair-retry being used.
            _log("claude", "first response didn't parse → repair retry", "warn")
    except Exception as exc:
        # ERROR: network/timeout → safe fallback served.
        _log("claude", f"first call raised ({exc}) → safe fallback (no repair)", "error")
        return _fallback()

    # Attempt 2: repair retry. Only runs if first call RETURNED with bad JSON.
    if not first_returned:
        return _fallback()
    try:
        resp = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=400,
            system=SYSTEM_PROMPT,
            messages=[
                {"role": "user", "content": user_msg},
                {"role": "assistant", "content": first_text or "{}"},
                {"role": "user", "content": "Respond with the JSON object only. No prose, no fences."},
            ],
        )
        text = "".join(b.text for b in resp.content if b.type == "text")
        result = _validate_answer(_extract_json(text))
        result["_model"] = CLAUDE_MODEL
        # WARN: answer served, but repair-retry was needed.
        _log("claude", "ok (after repair)", "warn")
        return result
    except Exception as exc:
        # ERROR: safe fallback actually served.
        _log("claude", f"repair retry failed → safe fallback: {exc}", "error")
        return _fallback()


def query(question: str, model_preference: str | None = None) -> dict:
    """Answer a user question against the event log. Always returns a validated dict.

    Model selection (in priority order):
      1. ``model_preference`` (per-request override from the UI):
         - ``"k2"``     → force K2. On any K2 failure, still fall back to
                          Claude so the demo path stays alive.
         - ``"claude"`` → skip K2 entirely, go straight to Claude.
         - Anything else (or None) → fall through to default routing.
      2. Default routing:
         - ``REWIND_DEMO_MODE`` on → Claude-only path (demo safety dial).
         - ``K2_ENDPOINT`` + ``K2_API_KEY`` set → K2 primary, Claude failover.
         - Otherwise → Claude only.
      3. ``_SAFE_FALLBACK`` if every path fails; response carries
         ``_model: "fallback"``.

    See CONTRACTS.md §3c for the response shape and the _model enum.
    """
    events = load_recent_events()
    log_text = format_log(events)

    # ---- User-driven override (UI model selector) ----
    pref = (model_preference or "").strip().lower()
    if pref == "claude":
        _log("query", "user chose Claude → skipping K2")
        return call_claude(log_text, question)
    if pref == "k2":
        _log("query", "user chose K2 → forcing K2 path")
        k2_result = call_k2(log_text, question)
        if k2_result is not None:
            k2_result["_model"] = K2_MODEL
            _log("k2", "ok")
            return k2_result
        # User asked for K2 but it failed. Fall back to Claude so the demo
        # doesn't produce a blank answer, but log WARN so the operator can
        # tell the user-requested model didn't actually answer.
        _log("query", "K2 requested but failed — falling back to Claude", "warn")
        return call_claude(log_text, question)

    # ---- Default routing (no override) ----
    # DEMO_MODE short-circuits the K2 primary path entirely. Reason: K2 is
    # useful when it works, but at the demo moment we prefer a known-good
    # Claude call over a K2 failover dance that might eat a timeout.
    if not REWIND_DEMO_MODE:
        k2_result = call_k2(log_text, question)
        if k2_result is not None:
            k2_result["_model"] = K2_MODEL
            _log("k2", "ok")
            return k2_result

    # call_claude sets its own _model (either CLAUDE_MODEL or "fallback").
    return call_claude(log_text, question)


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python query.py \"your question\"")
        sys.exit(1)
    question = " ".join(sys.argv[1:])
    print(json.dumps(query(question), indent=2))


if __name__ == "__main__":
    main()
