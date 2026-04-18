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
K2_MODEL = "k2-think-v2"

SYSTEM_PROMPT = """You are the reasoning layer of Rewind, an on-device \
episodic-memory system for a physical space. You receive a structured event log \
and a user query. Answer strictly from the log. Never invent events. Respond \
in JSON only: {"answer": string, "confidence": "high"|"medium"|"low", "event_ids": [int]}. \
Keep answers under 2 sentences, warm tone, include specific times. If the log \
doesn't contain the answer, say: "I didn't see that happen.\""""

_SAFE_FALLBACK: dict[str, Any] = {
    "answer": "I didn't see that happen.",
    "confidence": "low",
    "event_ids": [],
}

# Per-call timeouts, picked so worst-case total to safe-fallback stays bounded.
# See CONTRACTS.md §3c timeouts for the full budget discussion.
K2_TIMEOUT_S = 8.0
CLAUDE_TIMEOUT_S = 10.0


def _fallback(model_tag: str = "fallback") -> dict[str, Any]:
    """Build a fresh copy of the safe fallback with `_model` set."""
    return {**_SAFE_FALLBACK, "_model": model_tag}


@dataclass
class EventRow:
    id: int
    ts: float
    event_type: str
    object: str


def load_recent_events(db_path: Path = DB_PATH, limit: int = RECENT_EVENTS_LIMIT) -> list[EventRow]:
    if not db_path.exists():
        return _mock_events()
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        "SELECT id, ts, event_type, object FROM events ORDER BY ts DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [EventRow(*r) for r in reversed(rows)]


def _mock_events() -> list[EventRow]:
    """Synthetic events covering the three demo scenarios.

    Anchored to relative offsets from `now` so the timeline is always
    coherent regardless of what time the demo runs:
      - morning meds: ~9 hours ago
      - person traffic: ~6 hours ago
      - keys picked up: ~4 hours ago
      - water placed: ~2 hours ago
      - judge places book: ~3 minutes ago
      - person leaves: ~1 minute ago

    Returned in chronological order (oldest first) to match how
    `load_recent_events` delivers real rows to `format_log`.
    """
    now = datetime.now().timestamp()
    return [
        EventRow(1, now - 9 * 3600,        "object_picked_up", "scissors"),     # pill bottle stand-in
        EventRow(2, now - 9 * 3600 + 15,   "action_detected",  "drinking_cup"),
        EventRow(3, now - 6 * 3600,        "person_entered",   "person"),
        EventRow(4, now - 6 * 3600 + 60,   "person_left",      "person"),
        EventRow(5, now - 4 * 3600,        "object_picked_up", "remote"),       # keys stand-in
        EventRow(6, now - 2 * 3600,        "object_placed",    "bottle"),
        EventRow(7, now - 180,             "object_placed",    "book"),
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
DISPLAY_LABELS: dict[str, str] = {
    "scissors":  "pill bottle",
    "remote":    "keys",
    "cup":       "water glass",
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
    """
    lines = []
    now = datetime.now().timestamp()
    for e in events:
        tstr = datetime.fromtimestamp(e.ts).strftime("%H:%M:%S")
        rel  = humanize_timestamp(e.ts, now)
        obj  = _display_label(e.object)
        lines.append(f"[id={e.id}] [{tstr} · {rel}] {e.event_type}: {obj}")
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


def _extract_json(text: str) -> dict:
    """Pull a JSON object out of an LLM response, even if wrapped in prose or fences.

    Strategy ladder:
      1. Direct json.loads
      2. Strip ```json / ``` fences and retry
      3. Regex for the first balanced {...} block
    Raises ValueError if no strategy works.
    """
    s = text.strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    stripped = s.replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", stripped, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass

    raise ValueError(f"no JSON object found in response: {text[:200]!r}")


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
    """K2 Think V2 primary path. Returns None on any failure so the caller falls back."""
    if not k2_configured():
        return None
    try:
        r = httpx.post(
            K2_ENDPOINT,
            json={
                "model": K2_MODEL,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": f"Event log:\n{log_text}\n\nQuery: {question}"},
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0.2,
            },
            headers={"Authorization": f"Bearer {K2_API_KEY}"},
            timeout=K2_TIMEOUT_S,
        )
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        return _validate_answer(_extract_json(content))
    except Exception as exc:
        # WARN: K2 failover to Claude is a degraded path but still a valid answer.
        _log("k2", f"failed → falling back to Claude: {exc}", "warn")
        return None


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


def query(question: str) -> dict:
    """Answer a user question against the event log. Always returns a validated dict.

    Model selection:
      - K2 primary when K2_ENDPOINT + K2_API_KEY are set.
      - Claude failover otherwise (or on any K2 error).
      - Safe fallback when both fail; response carries `_model: "fallback"`.

    See CONTRACTS.md §3c for the response shape and the _model enum.
    """
    events = load_recent_events()
    log_text = format_log(events)

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
