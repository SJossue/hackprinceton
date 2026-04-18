"""Smoke test for the Rewind query engine.

Run after installing deps and setting ANTHROPIC_API_KEY:
    cd backend && source .venv/bin/activate
    python test_scenarios.py

Validates the query path end-to-end against the mock event log baked into
query.py (no SQLite or capture.py required). Catches the two things that
most commonly break the demo:
  1. Claude returns prose instead of JSON → extraction/repair must kick in
  2. A question with no supporting events → must return the safe fallback

Exit codes:
    0 — all scenarios behaved correctly
    1 — missing ANTHROPIC_API_KEY (setup problem, not a code bug)
    2 — at least one scenario misbehaved
"""

from __future__ import annotations

import sys

import query as query_mod

SAFE_FALLBACK_ANSWER = "I didn't see that happen."

# (question, mode)
# mode="real"     → answer must NOT be the safe fallback
# mode="fallback" → answer MUST be the safe fallback (nothing in log supports it)
SCENARIOS: list[tuple[str, str]] = [
    ("What objects have been picked up today?", "real"),
    ("When did the last person leave?",         "real"),
    ("What was the last thing placed down?",     "real"),
    ("Did I take my pills this morning?",        "real"),
    ("Where are my keys?",                       "real"),
    ("Where is my laptop?",                      "fallback"),
]


def _check(result: dict, mode: str) -> tuple[bool, str]:
    ans = str(result.get("answer", "")).strip()
    if not ans:
        return False, "empty answer"

    if mode == "fallback":
        if ans == SAFE_FALLBACK_ANSWER:
            return True, "fallback as expected"
        return False, f"expected fallback, got: {ans!r}"

    # mode == "real"
    if ans == SAFE_FALLBACK_ANSWER:
        return False, "unexpected fallback — log supports this question"
    return True, ans


def run() -> int:
    if not query_mod.ANTHROPIC_API_KEY:
        print("SETUP: ANTHROPIC_API_KEY not set. cp ../.env.example .env and fill it.",
              file=sys.stderr)
        return 1

    passed = failed = 0
    for question, mode in SCENARIOS:
        result = query_mod.query(question)
        ok, note = _check(result, mode)
        tag = "PASS" if ok else "FAIL"
        if ok:
            passed += 1
        else:
            failed += 1
        print(f"[{tag}] ({mode:8s}) {question}")
        print(f"         answer:    {result.get('answer', '??')!r}")
        print(f"         model:     {result.get('_model', '?')}")
        print(f"         confidence:{result.get('confidence', '?')}  "
              f"event_ids={result.get('event_ids', [])}")
        if not ok:
            print(f"         REASON:    {note}")
        print()

    total = len(SCENARIOS)
    print(f"Summary: {passed}/{total} pass, {failed}/{total} fail")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(run())
