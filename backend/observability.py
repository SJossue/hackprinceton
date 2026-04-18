"""
Rewind — observability helpers.
Owner: Jossue

Two artifacts live here by design because they serve different audiences:

- ``rewind.log`` — infra telemetry. Three-level split so the failure layer is
  obvious at a glance:
    INFO  — request received/answered, model used, latency.
    WARN  — fallback triggered, K2 failover, slow (>5s), repair-retry used.
    ERROR — safe fallback actually served, unrecoverable exception.
  Rotating (2 MB × 5). ``tail -f backend/rewind.log`` at demo time is fine —
  judges noticing the production-feel is a feature, not a bug.

- ``queries.jsonl`` — product corpus, one JSON line per ``/query`` hit.
  Schema: ``{ts, question, answer, model, latency_ms, confidence, event_ids}``.
  Append-only, never rotated — Phase D A/B tests run against this accumulated
  real-question stream, not hypotheticals.

Both files land in the backend's working directory (matches ``DB_PATH``).
Both are gitignored.
"""
from __future__ import annotations

import json
import logging
import logging.handlers
import sys
import time
from pathlib import Path

LOG_PATH = Path("rewind.log")
JOURNAL_PATH = Path("queries.jsonl")

SLOW_REQUEST_MS = 5000  # WARN threshold on /query latency

_logger: logging.Logger | None = None


def get_logger() -> logging.Logger:
    """Lazy singleton so uvicorn reloads don't stack duplicate handlers."""
    global _logger
    if _logger is not None:
        return _logger

    lg = logging.getLogger("rewind")
    lg.setLevel(logging.INFO)
    lg.propagate = False  # don't double-emit through root/uvicorn logger

    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-5s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

    # File sink — the thing you tail at demo time.
    fh = logging.handlers.RotatingFileHandler(
        LOG_PATH, maxBytes=2 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    fh.setFormatter(fmt)
    lg.addHandler(fh)

    # Also to stderr so the uvicorn terminal shows the same semantic stream.
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    lg.addHandler(sh)

    _logger = lg
    return lg


def journal_query(
    *,
    question: str,
    answer: str,
    model: str,
    latency_ms: int,
    confidence: str,
    event_ids: list[int],
) -> None:
    """Append one JSON line per ``/query`` hit to ``queries.jsonl``.

    Fails silently — the corpus is a lagging artifact. Losing a line is
    annoying; losing an answer is a demo bug. Journal writes must never
    take down the product path.
    """
    record = {
        "ts": time.time(),
        "question": question,
        "answer": answer,
        "model": model,
        "latency_ms": latency_ms,
        "confidence": confidence,
        "event_ids": event_ids,
    }
    try:
        with JOURNAL_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        get_logger().warning("journal_query: append failed", exc_info=True)
