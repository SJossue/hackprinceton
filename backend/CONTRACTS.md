# Backend Integration Contracts

**Owner: Jossue.** Source of truth for every wire into and out of the backend. If you're Sunghoo producing events, or Jeeyan consuming them, this file answers your schema question — don't ping me, don't guess, don't read the source. If the contract is ambiguous, that's a bug on me and I'll fix it here first.

**Editing rule:** a contract change requires a matching implementation change in the same commit. If this file and the code drift, the code is wrong by definition.

---

## 0. The three wires at a glance

```
┌────────────┐  POST /internal/event_added   ┌──────────────────┐
│ pi/        │ ────────────────────────────▶ │ backend/         │
│ capture.py │  (localhost only, §1)         │ FastAPI server   │
└────────────┘                                │                  │
                                              │                  │  GET /events       ┌─────────────┐
                                              │                  │ ─────────────────▶ │ frontend/   │
                                              │                  │  WS /ws/events     │ Next.js     │
                                              │                  │  POST /query       │ dashboard   │
                                              │                  │  POST /agent/check │             │
                                              └──────────────────┘ ◀──────────────── └─────────────┘
```

Ports: backend runs on `:8000`. Pi and backend share `127.0.0.1`. Laptop hits `http://<pi-ip>:8000`.

---

## 1. Event ingestion — `capture.py` → backend

**Endpoint:** `POST http://127.0.0.1:8000/internal/event_added`
**Access control:** **localhost only.** Requests from a non-`127.0.0.1` client address get `403 Forbidden`. Enforced by FastAPI middleware. If you see a 403, you're hitting from the wrong host — the backend and `capture.py` must both run on the Pi.
**Content-Type:** `application/json`
**Idempotency:** not enforced. Do not retry on success; retry on timeout is safe because duplicate IDs are rejected by SQLite's `INTEGER PRIMARY KEY AUTOINCREMENT`.

### Request body

```jsonc
{
  "id":          42,               // int, required. Unique, monotonically increasing.
  "ts":          1713456789.123,   // float, required. Unix seconds, subsecond OK.
  "event_type":  "object_placed",  // string, required. One of the enum below.
  "object":      "bottle",         // string, required. See § object conventions.
  "track_id":    17,               // int | null, optional. ByteTrack track id.
  "thumb_path":  "thumbs/1713456789123.jpg", // string | null, optional.
  "location":    "the desk"        // string | null, optional. Spatial grounding —
                                   // "the desk", "the chair", etc. Resolved by
                                   // capture.py against SURFACES. None for person
                                   // and action events (location of a person isn't
                                   // meaningful in this model); None on object
                                   // events when no surface match was found.
}
```

### `event_type` enum (closed set — do not invent new values without a contract bump)

| value | meaning | typical `object` |
|---|---|---|
| `object_placed` | A tracked object has been stably visible ≥3 frames (~0.6 s @ 5 fps) | `bottle`, `remote`, `book`, `cell phone` |
| `object_picked_up` | A previously-confirmed object has been missing ≥10 frames (~2 s) | same as above |
| `person_entered` | A `person` track has stably appeared | `person` |
| `person_left` | A confirmed `person` track has disappeared | `person` |
| `action_detected` | A person+object rule matched, debounced per-action at 8 s | `taking_pills`, `using_phone`, `reading` |

### `object` conventions

- For object events: the COCO class label verbatim (e.g. `bottle`, `cell phone`, `remote`, `book`). Lowercase, no trailing whitespace. Note: after the spatial-grounding rework, `HERO_OBJECTS` no longer includes `scissors` or `cup` — the Pi won't emit those.
- For `person_entered` / `person_left`: always `person`.
- For `action_detected`: the action name alone — `taking_pills`, `using_phone`, `reading`. (Older `drinking_{bottle,cup}` values are retired with the spatial-grounding rework.)
- Demo stand-ins (COCO has no "keys" or "pill bottle"): the Pi emits the COCO label (`remote` for keys, `bottle` for pill bottle). The query layer translates them via `DISPLAY_LABELS` before they reach the LLM. **Do not rewrite labels at ingestion.**

### `location` conventions

- Friendly surface name pre-resolved by `capture.py` (`the desk`, `the chair`). The word `the` is included — designed to drop into natural-language output as `"{event} on {location}"` without extra formatting.
- Set on `object_placed` / `object_picked_up` events when the object's bottom-center sits inside (or its bbox meaningfully overlaps) a known surface bbox per frame. See `resolve_location()` in `pi/capture.py` for the ranking heuristic.
- `null` for person events and action events, and for any object event where no surface match was found.
- Backend stores verbatim. Query layer appends ` on {location}` to each event line in `format_log` when present.

### `thumb_path` conventions

Relative path from the directory that `capture.py` runs from (usually `pi/`). Currently `thumbs/{ts_ms}.jpg`, produced by `save_thumb()` in `capture.py`. The backend stores this string verbatim and does **not** currently serve the file — v1 frontend doesn't render thumbnails. If v2 adds an `<img>` in the timeline, we'll add a `/thumbs/{filename}` route and the contract will change here.

### Success response

```json
{ "status": "ok" }
```

Status `200`. No retry on this.

### Failure modes

| Condition | Server behavior | `capture.py` expected behavior |
|---|---|---|
| Required field missing or wrong type | `422 Unprocessable Entity` with validation detail | log locally, **do not retry** — this is a code bug |
| Non-localhost source address | `403 Forbidden` | log locally; indicates a misconfigured network setup |
| Backend down or unreachable | connection error (no HTTP response) | swallow exception, keep frame loop running; events still land in SQLite |
| Duplicate `id` | `500` (SQLite unique constraint) | **do not** emit duplicate ids; use AUTOINCREMENT |

**Failure philosophy:** `capture.py` posting to the backend is best-effort. The authoritative record is SQLite on the Pi. A broadcast miss costs nothing because the frontend's next `GET /events` poll picks it up.

---

## 2. Event broadcast — backend → frontend (WebSocket)

**Endpoint:** `ws://<pi-ip>:8000/ws/events`
**Subprotocol:** none.
**Auth:** none (same-network demo; not public-safe).

### Client → server (keepalive)

The client sends any text frame every 15 seconds to prove liveness. Convention is the literal string `"ping"`. The server reads and discards the content; the read is purely used to detect socket closure. A client that stops sending will be cleaned up on the next server-side broadcast attempt that errors out.

```
client → server: "ping"    // every 15s
```

### Server → client (events)

One event per text frame. Frames are emitted only when `POST /internal/event_added` succeeds (see §1). Shape is identical to the ingestion body — no translation:

```json
{
  "id": 42,
  "ts": 1713456789.123,
  "event_type": "object_placed",
  "object": "bottle",
  "track_id": 17,
  "thumb_path": "thumbs/1713456789123.jpg",
  "location": "the desk"
}
```

### Frontend responsibilities

- On mount: `GET /events?limit=80` to backfill the timeline, **then** open the WebSocket. This avoids the race where new events arrive during the backfill.
- On `onclose`: reconnect with exponential backoff (500 ms → 1s → 2s → 4s → 8s, cap at 8s). Don't hammer.
- Deduplicate on `id` — a client that just reconnected may see an event it already backfilled via `GET /events`.
- Order by `ts` descending for display.

### Failure modes

| Condition | Server behavior | Client expected behavior |
|---|---|---|
| Client hasn't pinged in a while | Server still holds the socket until next broadcast fails | No action needed; ping timer drives keepalive |
| Network drop | Socket errors on next send, client dropped silently | Reconnect with backoff |
| Server restart | All sockets close | Reconnect; backfill via `GET /events` |

---

## 3. Query API — frontend → backend

### 3a. `GET /health`

No body. Returns current server state. Cheap — no LLM call. Safe to poll at ≤1 Hz.

```jsonc
{
  "ok": true,
  "db": {
    "path": "rewind.db",
    "exists": true,
    "event_count": 847          // -1 if DB exists but schema not yet initialized
  },
  "llm": {
    "claude": true,              // ANTHROPIC_API_KEY set
    "k2": false,                 // K2_ENDPOINT + K2_API_KEY both set
    "primary": "claude"          // which one /query will try first
  },
  "websocket_clients": 2
}
```

### 3b. `GET /events?limit=N`

Returns the last `N` events (default 80, max not enforced but practical limit ~500) in DESC order by `ts`. `EventRow[]` matching the §1 ingestion shape, minus `bbox` (stored in SQLite but not broadcast).

### 3c. `POST /query`

**Request:**
```json
{ "question": "where did I leave my keys?" }
```
- `question`: string, required. 1–500 chars advisory. Longer inputs will be accepted; very long inputs slow down the LLM call and risk the 12 s server timeout.

**Response:**
```jsonc
{
  "answer":     "You left them on the kitchen counter at 10:48 AM.",
  "confidence": "high",            // "high" | "medium" | "low"
  "event_ids":  [5],               // int[]. IDs from the event log that were used.
  "_model":     "claude-opus-4-7"  // see enum below
}
```

**`_model` enum:**

| value | meaning |
|---|---|
| `"k2-think-v2"` | K2 Think V2 answered successfully |
| `"claude-opus-4-7"` | Claude 4.7 answered (either primary if K2 unset, or failover after K2 error) |
| `"fallback"` | Both LLM paths failed; response is the safe fallback `"I didn't see that happen."` |

Frontend may style differently by model (e.g. show a small "K2" badge when K2 handled it). Don't hide the fallback — it's a truthful "I don't know" and users should see it.

**Timeouts (per-call, not a hard wall-clock total):**
- K2 primary: 8 s per attempt. Typical success ≤3 s.
- Claude failover: 10 s per attempt. Repair retry fires **only** when the first call returned bad JSON — not when it timed out (so a hung first call doesn't double the total).
- Typical happy path: 2–5 s (K2 win, or Claude direct).
- K2-times-out + Claude-succeeds: ~10 s.
- Degenerate (K2 hangs + Claude hangs): ~18 s → safe fallback with `_model: "fallback"`.
- Frontend should set its `fetch` timeout to 20 s.

**Answer length:** 1–2 sentences, warm tone, specific times when the log supports it. Max ~240 chars. If an LLM returns more, the content is still returned as-is — the frontend may truncate for SenseCAP (2-line) display but the answer card can render full text.

### 3d. `POST /agent/check`

No body. Runs the Eragon proactive agent. Returns `Alert[]` — may be empty.

```jsonc
[
  {
    "severity": "urgent",                // "info" | "warn" | "urgent"
    "title":    "Missed: Evening medication",
    "body":     "Scheduled for 18:00; 127 min overdue.",
    "suggested_action": {
      "type":     "send_text",           // "send_text" | (future: "draft_email", "add_event", ...)
      "to":       "+1-555-0199",
      "to_name":  "Sarah (daughter)",
      "draft":    "Hi Sarah — just a heads up, Dad hasn't picked up..."
    }
  }
]
```

- `suggested_action` is `null` for informational alerts with no call-to-action.
- `draft` is `null` when the agent couldn't generate one (e.g. Claude unreachable). The alert still fires; the frontend shows the alert body without a draft card.
- Agent timeout: 20 s (higher than `/query` because the Claude SMS-drafting call is the slow part).

---

## 3e. Ambient state channel — `/ws/state` + `/internal/state`

A second, narrower wire from backend to the ambient display (phone-stand fallback, or SenseCAP serial bridge). Strictly separate from `/ws/events` so the event firehose doesn't flood the display and a stuck display client doesn't back-pressure event clients.

### Subscribe (anyone on the same network)

**Endpoint:** `ws://<pi-ip>:8000/ws/state`
**Server → client messages:**

```jsonc
{ "state": "idle" }                                       // sent on connect + on idle transition
{ "state": "listening" }                                  // user is being heard
{ "state": "thinking" }                                   // LLM call in flight
{ "state": "answer",   "text": "On the desk, 3 min ago." }  // answer ready
{ "state": "alert",    "text": "Evening meds 2h overdue" }  // Eragon alert
```

Clients render what they understand, ignore unknowns. Payload keys match the JSON-lines in `sensecap/README.md` verbatim so if the SenseCAP firmware ships, it's a thin pass-through to `/dev/ttyACM0` — no schema translation.

### Trigger (Pi-local only)

**Endpoint:** `POST http://127.0.0.1:8000/internal/state`
**Access control:** localhost-only, same middleware gate as `/internal/event_added`.
**Body:** `{"state": "listening" | "thinking" | "answer" | "alert" | "idle", "text"?: string}`. Server broadcasts verbatim to all `/ws/state` subscribers.

**Who hits it:**

- Grove button handler on the Pi, on press → `{"state": "listening"}`.
- Any Pi-side script needing to drive the display.
- The backend itself auto-broadcasts `thinking` at `/query` start and `answer` at `/query` return — **no integration work needed** for typed-query path; it drives the ambient display for free.

### Failure modes

| Condition | Behavior |
|---|---|
| No subscribers | `broadcast_state()` iterates zero clients, succeeds silently. |
| A subscriber's socket dies mid-send | Dropped from `state_clients` set on next iteration. |
| Malformed body to `/internal/state` | Pydantic 422; display unchanged. |

---

## 3f. Environment flags — demo-day safety dials

Two independent env flags, read once at backend import:

### `REWIND_DEMO_MODE`

Truthy values (`1`, `true`, `yes`, `on`) activate. When on:

- K2 primary path is **skipped** — `/query` goes straight to Claude. No failover dance, no timeout absorption from a misbehaving K2.
- Claude per-call timeout drops from **10 s → 6 s**. Worst-case to safe-fallback stays inside the demo-moment latency budget.
- Banner renders `DEMO MODE: ✓ Claude-only, CLAUDE_TIMEOUT=6s`.

Usage: `REWIND_DEMO_MODE=1 uvicorn server:app --host 0.0.0.0 --port 8000`. Unset for normal ops.

### `REWIND_FIXTURE_MODE` (reserved, not implemented yet)

When it lands: inject `_mock_events()` transparently when SQLite is empty or the latest event is >30 min stale. Separate flag from DEMO_MODE so at judging you can enable Claude-only safety **without** forcing fake data — flip FIXTURE_MODE additionally only when live events glitch.

---

## 4. Degradation ladder (what the user sees when things go wrong)

| Failure | User-visible behavior |
|---|---|
| K2 endpoint misconfigured or slow | Silently falls through to Claude. `_model: "claude-opus-4-7"`. |
| Claude malformed first response | One repair retry with "JSON only" nudge. `_model` unchanged if successful. |
| Claude totally unreachable | Safe fallback text. `_model: "fallback"`. Frontend shows the answer honestly. |
| SQLite unreadable or missing | `/events` returns `[]`. `/query` uses mock events from `query.py:_mock_events()` so the demo still works. |
| `capture.py` down | `/events` still serves whatever's already in SQLite. WebSocket is quiet (no new events). |
| WebSocket drop | Client reconnects; backfills via `GET /events`. |
| Malformed LLM JSON | Extractor ladder (direct → fences → regex) recovers. If all fail, safe fallback. |
| Rate limit from Anthropic | Surfaces as a Claude exception → safe fallback. |

**Principle:** every failure returns a valid-shape response. The frontend never has to branch on `null` or `undefined`.

---

## 4b. Gotchas — loud invariants, hard-won

Things that will cost you 20 minutes if you forget them. Read this section before you ping me with "why is X doing Y."

### The `/internal/*` same-machine invariant

`capture.py` and the backend **must run on the same machine** (127.0.0.1 both ways). The 403 middleware in `server.py` enforces this for `/internal/*` — it is a feature, not a bug. If you're ever tempted to run `capture.py` on a laptop pushing to a Pi backend for "easier dev":

- Don't. SSH to the Pi and run it there.
- Or, if you *really* need remote dev, SSH-tunnel local port 8000 to the Pi's 8000, which makes your laptop's `127.0.0.1:8000` the Pi's backend — and the middleware is happy because the traffic arrives at the Pi as localhost.
- Do not remove the middleware "just for testing." It has prevented one real class of prompt-injection attack (a fake event arriving from the venue WiFi while judges are near the device).

### Timestamp units

`ts` is **Unix seconds as float**, not milliseconds. In Python: `time.time()`. In JS: `Date.now() / 1000`, or `new Date(ts * 1000)` to render. `ts * 1000` for `new Date()` is the single most common forget. Every example in `backend/examples/` uses seconds; compare against them if unsure.

### WebSocket dedupe

On first connect the frontend does `GET /events?limit=80` *then* opens the WebSocket. Events generated in the millisecond gap can arrive on both paths. **Dedupe on `id`** — which is monotonically increasing from SQLite's `AUTOINCREMENT`, so it's safe as a Set key. This is documented in §2 but people miss it.

### Single-event JSON fixtures vs. the in-code timeline

`backend/examples/*.json` are **single-event** fixtures — one row per file, for schema reference, Jeeyan's MSW mocks, and `curl -d @file` smoke tests. The rolling 8-event demo timeline lives in `query.py::_mock_events()` because its timestamps are computed *relative to `now`* so the demo stays coherent whatever time of day it runs. If you want a saved timeline for deterministic tests, build a separate fixture file — don't try to baké time-relative events into a static JSON.

### `_model: "fallback"` in a response is not a bug

It means the LLM path failed (K2 error + Claude error, or both unreachable). The response is still valid-shape. The UI should surface it honestly rather than hide it. If you're seeing it unexpectedly, check the server logs — `[claude]` / `[k2]` tags tell you which leg actually broke.

### `event_ids` may be empty

Valid-shape response includes `"event_ids": []` — the model genuinely couldn't point at supporting events (common on the safe-fallback path, also happens when the model answers from general inference rather than specific log entries). Don't assume non-empty.

### K2 is "configured" iff both vars look real

`K2_ENDPOINT` and `K2_API_KEY` are treated as configured only when both are non-empty **and** neither contains `...` (the placeholder from `.env.example`). If you leave the example's `https://.../v1/chat/completions` in `.env` intact, the backend correctly treats K2 as unset and routes to Claude — the banner, `/health`, and `_model` in responses all tell the truth. To enable K2, put real values in; don't half-fill. Generalization for later: config loading could treat empty-string as unset universally and drop the `...` sentinel entirely — noted as a Phase C polish.

### Port 8000 can clash

If something else on the Pi is on 8000 (monitoring, another project), override with `uvicorn server:app --port 8001` and update **both** `pi/capture.py::SERVER_BASE` and `frontend/.env.local::NEXT_PUBLIC_REWIND_API` to match. Ping Sunghoo + Jeeyan before the change — one of them will forget.

---

## 4c. Adding a new `event_type`

**Default answer: don't.** The five in §1 cover every demo scenario. If at 3 AM Saturday you think you need `object_moved` or `cooking_detected`, first ask: can you emit one of the existing types with a different `object` label? `action_detected` with `object: "cooking_pan"` probably covers 80% of what you wanted.

If you genuinely need one (which forces a contract bump), the migration path — in order, same commit bundle:

1. **Update this file.** Add the new value to the §1 enum table with its semantics, and the `object` convention row if relevant. Add the value to the §5 validation one-liner's allowed set.
2. **Add a canonical example** under `backend/examples/event_<new_type>.json`.
3. **Update `query.py`** — the prompt template doesn't list event types but `format_log` needs no change; no code touch usually needed unless the agent logic keys off `event_type`.
4. **Ping Sunghoo + Jeeyan in Slack** with the commit SHA. Sunghoo updates `capture.py` to emit it (if it's a CV event). Jeeyan adds any distinctive rendering if needed.
5. **Bump the version marker at the bottom** — `v1 → v2`, note what changed.

One PR, three files minimum (`CONTRACTS.md`, `examples/event_*.json`, optionally `query.py`). If either of the other two owners needs more than 10 minutes to integrate, it means the event type wasn't actually necessary — reconsider.

---

## 5. Validation one-liners

Sunghoo — verify a capture.py output payload:

```bash
python -c "
import json, sys
d = json.load(sys.stdin)
required = {'id', 'ts', 'event_type', 'object'}
assert required <= d.keys(), f'missing: {required - d.keys()}'
assert d['event_type'] in {'object_placed','object_picked_up','person_entered','person_left','action_detected'}, d['event_type']
assert isinstance(d['ts'], (int, float)) and d['ts'] > 1_700_000_000, 'ts looks wrong'
print('ok')
" < your_event.json
```

Jeeyan — sanity-check a `/query` response from the browser console:

```js
const ok = r => r.answer && ["high","medium","low"].includes(r.confidence)
  && Array.isArray(r.event_ids) && ["k2-think-v2","claude-opus-4-7","fallback"].includes(r._model);
```

Everyone — **Swagger UI is at `http://localhost:8000/docs`.** Every endpoint is testable with a click. Use it before asking me anything.

---

## 6. Canonical examples

Ten reference payloads live in [`backend/examples/`](./examples/). Copy-paste into mock data, unit fixtures, or `curl -d @file`. They match this contract exactly — if they ever diverge, **the examples are wrong** (bump them, not this doc).

| File | What it is |
|---|---|
| `examples/event_object_placed.json` | §1 ingestion — someone placed a bottle |
| `examples/event_object_picked_up.json` | §1 ingestion — someone picked up the remote (keys stand-in) |
| `examples/event_person_entered.json` | §1 ingestion — person walked into frame |
| `examples/event_person_left.json` | §1 ingestion — person left frame |
| `examples/event_action_detected.json` | §1 ingestion — drinking action detected |
| `examples/query_request.json` | §3c request body |
| `examples/query_response_found.json` | §3c successful answer with `_model: "claude-opus-4-7"` |
| `examples/query_response_fallback.json` | §3c degraded path with `_model: "fallback"` |
| `examples/agent_alerts_empty.json` | §3d — no alerts (all doses on track) |
| `examples/agent_alerts_overdue.json` | §3d — one urgent alert with a drafted SMS |

---

## 7. Change log

- **v1 (2026-04-18):** initial contract. Three wires locked. Localhost enforcement on `/internal/*`. `_model` enum includes `"fallback"`. Timeouts 12s query / 20s agent.
