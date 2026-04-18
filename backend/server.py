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
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import query as query_mod
import agent as agent_mod

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


class QueryIn(BaseModel):
    question: str


class EventIn(BaseModel):
    id: int
    ts: float
    event_type: str
    object: str
    track_id: int | None = None
    thumb_path: str | None = None


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
    lines = [
        "",
        "┌─ Rewind backend ─────────────────────────────────────",
        f"│  DB:     {'✓' if db['exists'] else '✗'}  {db['path']}  (events: {db['event_count']})",
        f"│  Claude: {'✓' if llm['claude'] else '✗'}  model={query_mod.CLAUDE_MODEL}",
        f"│  K2:     {'✓' if llm['k2'] else '✗'}  endpoint={query_mod.K2_ENDPOINT if llm['k2'] else '(unset)'}",
        f"│  Primary LLM: {llm['primary']}",
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
    rows = conn.execute(
        "SELECT id, ts, event_type, object, track_id, thumb_path FROM events "
        "ORDER BY ts DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/query")
def post_query(body: QueryIn) -> dict[str, Any]:
    return query_mod.query(body.question)


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
