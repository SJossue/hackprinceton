"""
Rewind — observability helpers.
Owner: Jossue

``rewind.log`` is infra telemetry. Three-level split so the failure layer is
obvious at a glance:
    INFO  — request received/answered, model used, latency.
    WARN  — fallback triggered, K2 failover, slow (>5s), repair-retry used.
    ERROR — safe fallback actually served, unrecoverable exception.

Rotating (2 MB × 5). ``tail -f backend/rewind.log`` at demo time is fine —
judges noticing the production-feel is a feature, not a bug.

The file lands in the backend's working directory (matches ``DB_PATH``).
Gitignored.

A separate ``queries.jsonl`` journal (the product corpus, not infra) will
live here too in a follow-up commit; these two serve different audiences on
purpose and shouldn't share a rotation policy.
"""
from __future__ import annotations

import logging
import logging.handlers
import sys
from pathlib import Path

LOG_PATH = Path("rewind.log")

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
