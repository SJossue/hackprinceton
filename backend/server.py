"""
Rewind — FastAPI server on the Pi
Owner: Jossue

Run:   uvicorn server:app --host 0.0.0.0 --port 8000
Deps:  fastapi, uvicorn, httpx, anthropic, python-dotenv

Exposes:
  GET  /health               - config + DB status (quick smoke test)
  GET  /events               - last N events (initial UI load)
  POST /query                - {"question": "..."} -> answer JSON
  POST /agent/check          - runs proactive agent, returns alerts
  WS   /ws/events            - broadcasts new events as capture.py adds them
  POST /internal/event_added - capture.py posts here to trigger WS broadcast
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import query as query_mod
import agent as agent_mod
from observability import SLOW_REQUEST_MS, get_logger, journal_query

_LOG = get_logger()

app = FastAPI(title="Rewind API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_LOCALHOST_ADDRS = {"127.0.0.1", "localhost", "::1"}


@app.middleware("http")
async def restrict_internal_to_localhost(request: Request, call_next):
    """Any /internal/* path must originate from the Pi itself (see CONTRACTS.md §1)."""
    if request.url.path.startswith("/internal/"):
        client_host = request.client.host if request.client else None
        if client_host not in _LOCALHOST_ADDRS:
            return JSONResponse(
                {"detail": f"forbidden: /internal/* is localhost-only (saw {client_host})"},
                status_code=403,
            )
    return await call_next(request)

DB_PATH = Path("rewind.db")
connected_clients: set[WebSocket] = set()
# Separate channel from /ws/events. Phone-stand /status UI and any ambient
# display (SenseCAP if firmware ships, phone fallback otherwise) subscribes
# here to show idle / listening / thinking / answer states. Event clients
# don't need state noise; state clients don't need event firehose.
state_clients: set[WebSocket] = set()


class QueryIn(BaseModel):
    question: str


class EventIn(BaseModel):
    id: int
    ts: float
    event_type: str
    object: str
    track_id: int | None = None
    thumb_path: str | None = None
    # Spatial grounding — pi/capture.py resolves the surface an object is
    # resting on (e.g. "the desk", "the chair") and ships it here. None
    # when the event doesn't involve a surface (person events, first-run
    # captures before the SURFACES dict was populated, etc.).
    location: str | None = None


def _db_event_count() -> int:
    if not DB_PATH.exists():
        return 0
    try:
        conn = sqlite3.connect(DB_PATH)
        n = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        conn.close()
        return int(n)
    except sqlite3.Error:
        return -1  # DB exists but schema isn't ready yet (capture.py hasn't initialized it)


def _status() -> dict[str, Any]:
    k2_on = query_mod.k2_configured()
    return {
        "ok": True,
        "db": {
            "path": str(DB_PATH),
            "exists": DB_PATH.exists(),
            "event_count": _db_event_count(),
        },
        "llm": {
            "claude": bool(query_mod.ANTHROPIC_API_KEY),
            "k2": k2_on,
            "primary": "k2" if k2_on else "claude",
        },
        "websocket_clients": len(connected_clients),
    }


@app.on_event("startup")
async def _banner() -> None:
    s = _status()
    db = s["db"]
    llm = s["llm"]
    demo_mode_str = (
        f"│  DEMO MODE: ✓ Claude-only, CLAUDE_TIMEOUT={query_mod.CLAUDE_TIMEOUT_S}s"
        if query_mod.REWIND_DEMO_MODE else
        f"│  DEMO MODE: ✗"
    )
    lines = [
        "",
        "┌─ Rewind backend ─────────────────────────────────────",
        f"│  DB:     {'✓' if db['exists'] else '✗'}  {db['path']}  (events: {db['event_count']})",
        f"│  Claude: {'✓' if llm['claude'] else '✗'}  model={query_mod.CLAUDE_MODEL}",
        f"│  K2:     {'✓' if llm['k2'] else '✗'}  endpoint={query_mod.K2_ENDPOINT if llm['k2'] else '(unset)'}",
        f"│  Primary LLM: {llm['primary']}",
        demo_mode_str,
        "│  Docs: http://localhost:8000/docs",
        "└───────────────────────────────────────────────────────",
        "",
    ]
    print("\n".join(lines))


@app.get("/health")
def get_health() -> dict[str, Any]:
    return _status()


@app.get("/events")
def get_events(limit: int = 80) -> list[dict[str, Any]]:
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # Guard: older capture.py schemas pre-date the `location` column.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(events)")}
    loc_col = "location" if "location" in cols else "NULL AS location"
    rows = conn.execute(
        f"SELECT id, ts, event_type, object, track_id, thumb_path, {loc_col} "
        f"FROM events ORDER BY ts DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/query")
async def post_query(body: QueryIn) -> dict[str, Any]:
    t0 = time.perf_counter()
    _LOG.info("/query received: %r", body.question)
    # Ambient state: thinking → answer (or idle on failure). Phone-stand
    # and SenseCAP subscribers get a visible UI transition even when the
    # query arrives via HTTP instead of a button press.
    await broadcast_state("thinking")
    result = query_mod.query(body.question)
    latency_ms = int((time.perf_counter() - t0) * 1000)

    model = result.get("_model", "unknown")
    confidence = result.get("confidence", "unknown")
    event_ids = result.get("event_ids", []) or []
    answer = result.get("answer", "")

    # Level split per PLAN.md §Phase C:
    # ERROR = safe fallback actually served (user got the "I didn't see that" apology).
    # WARN  = slow request (>5s) even if answer is valid.
    # INFO  = happy path.
    if model == "fallback":
        _LOG.error(
            "/query served safe fallback latency=%dms q=%r", latency_ms, body.question
        )
    elif latency_ms > SLOW_REQUEST_MS:
        _LOG.warning(
            "/query slow latency=%dms (>%dms) model=%s conf=%s",
            latency_ms, SLOW_REQUEST_MS, model, confidence,
        )
    else:
        _LOG.info(
            "/query ok model=%s latency=%dms conf=%s", model, latency_ms, confidence
        )

    # Product corpus (queries.jsonl) — separate from the infra log.
    journal_query(
        question=body.question,
        answer=answer,
        model=model,
        latency_ms=latency_ms,
        confidence=confidence,
        event_ids=event_ids,
    )

    # Ambient state: push the answer to /ws/state subscribers. The display
    # layer decides how long to show it and auto-returns to idle.
    await broadcast_state("answer", text=answer)

    return result


@app.post("/agent/check")
def post_agent_check() -> list[dict[str, Any]]:
    return agent_mod.run()


@app.websocket("/ws/events")
async def ws_events(ws: WebSocket) -> None:
    await ws.accept()
    connected_clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # keep-alive pings
    except WebSocketDisconnect:
        connected_clients.discard(ws)


@app.websocket("/ws/state")
async def ws_state(ws: WebSocket) -> None:
    """Ambient-display state channel. One subscriber per phone-stand
    (or SenseCAP serial bridge in a future sprint). Messages are tiny
    JSON objects: {"state": "idle|listening|thinking|answer", "text"?: str}.
    """
    await ws.accept()
    state_clients.add(ws)
    try:
        # Send current state on connect so late subscribers don't miss it.
        await ws.send_text(json.dumps({"state": "idle"}))
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        state_clients.discard(ws)


async def broadcast_event(event: dict[str, Any]) -> None:
    dead: list[WebSocket] = []
    for client in connected_clients:
        try:
            await client.send_text(json.dumps(event))
        except Exception:
            dead.append(client)
    for d in dead:
        connected_clients.discard(d)


@app.post("/internal/event_added")
async def internal_event_added(body: EventIn) -> dict[str, str]:
    await broadcast_event(body.model_dump())
    return {"status": "ok"}


# ---------- Ambient state broadcast -----------------------------------------

async def broadcast_state(state: str, text: str | None = None) -> None:
    """Push an ambient-display state change to all /ws/state subscribers.
    Payload: {"state": "idle|listening|thinking|answer", "text"?: str}.
    Fail-silent on per-client errors; a dead socket shouldn't cascade.
    """
    msg: dict[str, Any] = {"state": state}
    if text is not None:
        msg["text"] = text
    payload = json.dumps(msg)
    dead: list[WebSocket] = []
    for client in state_clients:
        try:
            await client.send_text(payload)
        except Exception:
            dead.append(client)
    for d in dead:
        state_clients.discard(d)


class StateIn(BaseModel):
    state: str
    text: str | None = None


@app.post("/internal/state")
async def internal_state(body: StateIn) -> dict[str, str]:
    """Localhost-only. Grove button handler, capture.py, or any Pi-side
    trigger hits this to push an ambient-display state. Accepts any state
    string — the clients render what they understand and ignore the rest.
    """
    await broadcast_state(body.state, body.text)
    _LOG.info("/internal/state -> %s%s", body.state,
              (" text=%r" % body.text) if body.text else "")
    return {"status": "ok"}
