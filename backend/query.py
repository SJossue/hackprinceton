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

load_dotenv()

DB_PATH = Path("rewind.db")
RECENT_EVENTS_LIMIT = 80
K2_ENDPOINT = os.getenv("K2_ENDPOINT", "")
K2_API_KEY = os.getenv("K2_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

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


def format_log(events: list[EventRow]) -> str:
    lines = []
    for e in events:
        tstr = datetime.fromtimestamp(e.ts).strftime("%H:%M:%S")
        lines.append(f"[id={e.id}] [{tstr}] {e.event_type}: {e.object}")
    return "\n".join(lines)


def _log(tag: str, msg: str) -> None:
    print(f"[{tag}] {msg}", file=sys.stderr)


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
    if not (K2_ENDPOINT and K2_API_KEY):
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
        _log("k2", f"failed → falling back to Claude: {exc}")
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
        _log("claude", "ANTHROPIC_API_KEY missing → safe fallback")
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
            _log("claude", "first response didn't parse → repair retry")
    except Exception as exc:
        _log("claude", f"first call raised ({exc}) → safe fallback (no repair)")
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
        _log("claude", "ok (after repair)")
        return result
    except Exception as exc:
        _log("claude", f"repair retry failed → safe fallback: {exc}")
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
