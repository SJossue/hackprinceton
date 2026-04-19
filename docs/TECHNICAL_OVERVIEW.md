# Rewind — Technical Overview

**Project:** HackPrinceton 2026 submission.
**Tagline:** *"Your home has a memory. Just ask."*
**Status as of submission:** `main` @ `d087098` — feature-complete, 6/6 smoke, Mode B verified end-to-end on live hardware.

This document describes every piece of the Rewind stack at an implementation level. For the pitch-facing story see [`VIDEO_NARRATIVE.md`](./VIDEO_NARRATIVE.md).

---

## 1. What Rewind is (technically)

An ambient wall-mounted camera node that extracts *events* from a room using computer vision, stores them locally in SQLite with privacy-preserving blurred thumbnails, and answers natural-language questions about the room's recent past through a reasoning LLM layer (K2 Think V2 primary, Claude 4.7 failover). A proactive agent ("Eragon") watches the event log for missed-medication patterns and drafts warm caregiver SMS messages. An ambient display (phone-stand fallback for the SenseCAP Indicator) speaks answers in a human voice via ElevenLabs TTS.

**Privacy invariant:** *video frames never leave the local network.* Only event metadata and text travel to the cloud (LLM calls). Enforced by the localhost gate on `/internal/*` endpoints and reinforced by the laptop-offload architecture where the Pi is a dumb sensor.

---

## 2. System architecture

Two deployment modes supported by a single codebase:

### Mode A — Pi-integrated (original)

```
┌────────────────────┐    127.0.0.1     ┌──────────────────┐
│  pi/capture.py     │ ───────────────▶ │  backend/        │
│  (YOLO + tracking  │                  │  FastAPI         │
│   + events + db)   │                  │  (on Pi)         │
└────────────────────┘                  │                  │      GET /events
                                         │                  │      WS  /ws/events
                                         │                  │ ───────────────────▶ frontend/
                                         │                  │      WS  /ws/state               dashboard
                                         │                  │      POST /query                +
                                         │                  │      POST /agent/check          phone-stand
                                         └──────────────────┘
```

YOLOv8n on Pi 4 CPU saturates at ~2 fps. Works but slow.

### Mode B — Laptop-offload (demo deployment)

```
┌────────────────────┐   MJPEG :9090   ┌─────────────────────────────────────┐
│ pi/stream_server   │ ───(LAN only)──▶ │  laptop (compute hub, G14/Mac)      │
│ (camera → MJPEG)   │                  │                                     │
└────────────────────┘                  │  capture_local.py ──POST localhost──┐
                                        │  (YOLO + tracking + events)         │
                                        │                                      │
                                        │  backend/ FastAPI                    │
                                        │                      GET /events    │ ──▶ frontend
                                        │                      WS  /ws/events  │     (same laptop
                                        │                      WS  /ws/state   │      or phone-stand)
                                        │                      POST /query    │
                                        │                      POST /agent/…  │
                                        └──────────────────────────────────────┘
```

Laptop's discrete GPU runs YOLOv8n at 20–21 fps. Ethernet LAN keeps MJPEG off cellular. **Privacy invariant still holds:** MJPEG never leaves the LAN.

---

## 3. Component breakdown

### 3.1 Pi sensor node (`pi/`)

- **`capture.py`** — Mode A entry point. Webcam → YOLOv8n tracking → event extractor → SQLite write + `POST /internal/event_added`. Includes an embedded MJPEG debug stream on port 9090.
- **`stream_server.py`** — Mode B entry point. Camera → encode JPEG at 21 fps → HTTP multipart MJPEG on port 9090. No YOLO. No DB. ~80 lines. Pi becomes a "smart IP camera."
- **`capture_local.py`** — runs on the compute-hub laptop. Pulls MJPEG stream, runs YOLOv8n locally, emits events to localhost backend. Same event taxonomy as `capture.py` — backend is agnostic to which path produced the event.

**Event extractor state machine:**
- `object_placed` — object stably visible ≥12 frames (~0.6 s @ 20 fps)
- `object_picked_up` — object missing ≥41 frames (~2 s)
- `person_entered` / `person_left` — person-class analog
- `action_detected` — person + specific object geometry rule:
  - `taking_pills` — person + `bottle` in upper-third of person bbox
  - `using_phone` — person + `cell phone` in upper-third
  - `reading` — person + `book` in middle-third
- 8-second debounce per action.

**Hero objects (COCO labels + confidence floors):**
```python
{"cell phone": 0.25, "bottle": 0.22, "remote": 0.25,
 "book": 0.25, "backpack": 0.25, "person": 0.50}
```

**Surfaces for spatial grounding:**
```python
{"dining table": ("the desk", 0.20), "chair": ("the chair", 0.20)}
```
`resolve_location()` uses bottom-center containment → IoU fallback to resolve which surface an object is resting on. Event carries `location: "the desk"` when matched.

**Privacy-preserving thumbnails:** 128×72 blurred JPEG per event, written to `thumbs/`. No face ever legible. Never leaves the LAN.

### 3.2 Backend (`backend/`)

FastAPI server (`server.py`), query engine (`query.py`), proactive agent (`agent.py`), observability helpers (`observability.py`), TTS module (`tts.py`).

**Endpoints:**

| Path | Method | Purpose |
|---|---|---|
| `/health` | GET | System status — DB state, LLM availability, demo-mode flag, banner parity |
| `/events?limit=N` | GET | Last N events, DESC by ts |
| `/query` | POST | `{question, model?}` → `{answer, confidence, event_ids, _model, audio_url?}` |
| `/agent/check` | POST | Run Eragon adherence check → `Alert[]` + broadcast to `/ws/state` |
| `/ws/events` | WS | Live event push to dashboard |
| `/ws/state` | WS | Ambient-display states (idle/listening/thinking/answer/alert) |
| `/internal/event_added` | POST | capture.py/capture_local.py posts events here. **Localhost-only.** |
| `/internal/state` | POST | Pi-local trigger for ambient state (Grove button, etc.) |
| `/audio/<file>.mp3` | GET | ElevenLabs-generated MP3s served via FastAPI StaticFiles |

**LLM routing (in priority order):**

1. **Per-request override** (`model` param from UI): `"k2"` forces K2 path, `"claude"` forces Claude, other/None → default routing.
2. **`REWIND_DEMO_MODE=1`** → Claude-only, CLAUDE_TIMEOUT=6s. Demo-day safety dial.
3. **`k2_configured()`** (both `K2_ENDPOINT` + `K2_API_KEY` set and non-placeholder) → K2 primary, Claude failover on any K2 error.
4. **Otherwise** → Claude only.
5. **Final fallback** → `_SAFE_FALLBACK` `{"answer": "I didn't see that happen.", …, "_model": "fallback"}`.

**K2 resilience (multiple reasoning-model quirks addressed):**
- No `response_format={"type":"json_object"}` — OpenAI-compat forks reject it.
- System prompt inlined into single user turn.
- `max_tokens=800` to accommodate reasoning prose + JSON.
- `K2_TIMEOUT_S=12` for cold-start tolerance.
- `_extract_json()` uses a brace-balanced scanner that finds every top-level `{...}` block and prefers the last one with an `"answer"` field (reasoning models emit scratch JSON before the final answer).
- Shouty "CRITICAL OUTPUT FORMAT" prompt tail with concrete example shape.
- Non-200 HTTP error surfaces the first 200 chars of the response body into `rewind.log`.

**Phase D data-layer fixes (data-layer, not prompt-layer):**
- `DISPLAY_LABELS` translation at the query-context seam — `bottle → "pill bottle"`, `remote → "keys"`, `book → "notebook"`. Ingestion layer stays pinned to COCO labels per CONTRACTS §1.
- `humanize_timestamp()` — contextual buckets: `a moment ago` / `N minutes ago` / `earlier today around 10 AM` / `yesterday around 10 PM` / `N days ago`. Each event line in `format_log` carries both absolute `HH:MM:SS` and relative phrase; LLM picks specificity by context.

**Eragon agent (`agent.py`):**
- Reads event log, mock calendar, mock contacts.
- Detects missed medication: evidence = `action_detected/taking_pills` (strongest) or `object_picked_up/bottle` (weaker, fallback).
- Claude-drafts a warm, non-alarmist caregiver SMS ("Hi Sarah, just a heads-up…").
- Draft-only as of `04a03e5` — Twilio removed. The drafted text is shown on dashboard and spoken via ElevenLabs on the ambient display. Production deployments would bolt on Twilio/Signal/email.

**ElevenLabs TTS (`tts.py`):**
- `eleven_flash_v2_5` model (~200 ms first byte).
- Fail-safe: returns `None` on any failure (unconfigured, network, 401, etc.) — text delivery continues text-only.
- MP3s written to `backend/audio/{ts_ms}.mp3`, served at `/audio/*` via StaticFiles. Gitignored.
- `/query` auto-generates audio for the answer and attaches `audio_url` to both the HTTP response and the `/ws/state` answer broadcast.
- `/agent/check` speaks the Claude-drafted SMS body (warmer than the clinical `"Missed: Morning medication — …"` title) on the alert broadcast.

**Observability (`observability.py`):**
- `rewind.log` — rotating file (2 MB × 5), three-level split: INFO (happy path) / WARN (fallback triggered, slow request, repair-retry) / ERROR (safe fallback actually served, unrecoverable exception). `tail -f` during demo is a legit production feel.
- `queries.jsonl` — append-only product corpus. One JSON line per `/query` hit: `{ts, question, answer, model, latency_ms, confidence, event_ids}`. Powers post-demo `grep` + future Phase D prompt A/B against real-question corpus.
- Both gitignored; honest-banner principle holds throughout.

**Env flags (`REWIND_DEMO_MODE`):**
Truthy values (`1`, `true`, `yes`, `on`) activate:
- K2 skipped entirely — Claude-only path.
- `CLAUDE_TIMEOUT_S` drops 10 → 6.
- Banner renders `DEMO MODE: ✓ Claude-only, CLAUDE_TIMEOUT=6s`.

`REWIND_FIXTURE_MODE` is reserved but not yet implemented (would inject `_mock_events` when live DB is empty/stale).

### 3.3 Frontend (`frontend/`)

Next.js 14.2.5 (pinned — see `d087098` — Ariji's accidental Next 16 bump had an ESLint peer conflict). React 18. Tailwind 3.4. lucide-react for icons. Single-page `app/page.tsx` at 1180+ lines, polished by Ariji.

**Key UI elements:**
- Live event timeline (left column) — populated from `GET /events?limit=80` on mount, updated via `WS /ws/events` subscription.
- Answer card (center) — question input + voice button (Web Speech STT) + answer render with `_model` attribution tag.
- **Model selector (segmented Auto / K2 / Claude)** — commit `f7dcde0`. Sends `model` field in the `/query` POST body; renders the target model slug ("next query → MBZUAI-IFM/K2-Think-v2") so judges can watch the routing take effect on the `_model` tag.
- Preset chip grid — common queries (where are my keys, did I take my pills, etc.).
- Alert panel — rendered from `/agent/check` responses with severity coloring.

**Voice I/O:** Web Speech API for STT (browser-native) and `speechSynthesis` for TTS when ElevenLabs audio isn't present in the response.

**Contract awareness:** `NEXT_PUBLIC_REWIND_API` env var points at the backend URL. Default `http://localhost:8000`.

### 3.4 Ambient display (`frontend/app/status/page.tsx` — phone-stand fallback)

Minimal full-screen route subscribing to `/ws/state`. Renders four states (idle / listening / thinking / answer / alert) with large typography and ElevenLabs audio playback when `audio_url` is present in the broadcast payload.

Replaces the originally-planned SenseCAP LVGL firmware (deferred per the 10 PM Friday cutoff in `sensecap/README.md`). Serial protocol JSON shape is preserved identically in `/ws/state` messages, so a future SenseCAP firmware would be a thin pass-through.

---

## 4. Event and data schemas (canonical)

### EventIn (POST `/internal/event_added`, broadcast `/ws/events`)

```jsonc
{
  "id": 42,                                // int, PK
  "ts": 1713456789.123,                    // float unix seconds
  "event_type": "object_placed",           // enum, see below
  "object": "bottle",                      // COCO label (or action name)
  "track_id": 17,                          // int | null
  "thumb_path": "thumbs/1713456789123.jpg",// string | null
  "location": "the desk"                   // string | null — spatial grounding
}
```

**event_type enum:** `object_placed`, `object_picked_up`, `person_entered`, `person_left`, `action_detected`.

**object conventions:** COCO verbatim (`bottle`, `cell phone`, `remote`, `book`, `backpack`, `person`) for object/person events. Action name (`taking_pills`, `using_phone`, `reading`) for `action_detected`. **Never rewrite at ingestion** — translation via `DISPLAY_LABELS` at query-context assembly only.

**location conventions:** friendly surface name pre-resolved (`"the desk"`, `"the chair"`). `null` for person events and unmatched surfaces. Designed to drop into `"{event} on {location}"` natural-language output.

### Query response (POST `/query`)

```jsonc
{
  "answer": "You picked up your keys from the desk at 10 PM yesterday; I haven't seen where you set them down since.",
  "confidence": "medium",                      // "high" | "medium" | "low"
  "event_ids": [5],                            // events cited in the answer
  "_model": "MBZUAI-IFM/K2-Think-v2",          // attribution — dashboard renders "via {model}"
  "audio_url": "/audio/1713456789123.mp3"      // optional, ElevenLabs MP3 when TTS configured
}
```

### State broadcast (`/ws/state`)

```jsonc
// on connect:
{ "state": "idle" }

// on /query start:
{ "state": "thinking" }

// on /query complete:
{ "state": "answer", "text": "...", "audio_url": "/audio/...mp3" }

// on /agent/check firing alerts:
{ "state": "alert", "text": "...", "audio_url": "/audio/...mp3" }
```

Shape matches `sensecap/README.md` serial protocol verbatim for future-proofing.

---

## 5. Reliability — the "never fails demo" contract

Layered fallbacks ensure the demo path always returns a valid-shape response:

```
/query  →  K2 Think V2 (primary)
         └─ timeout / HTTP error / JSON extraction fail
                ↓
             Claude 4.7 (failover)
               ├─ first-call raises    → safe fallback immediately
               ├─ first-call bad JSON  → repair retry (one attempt)
               └─ repair fails         → safe fallback
                                                ↓
                                      _SAFE_FALLBACK dict
                                      "I didn't see that happen."
```

Every path returns the same `{answer, confidence, event_ids}` shape. Frontend never branches on `null`. Safe fallback carries `_model: "fallback"` so the UI can render an honest "don't know" without the user thinking the device is broken.

---

## 6. Deployment recipes (from `RUNBOOK.md`)

### Mode B cold boot (the demo setup)

```bash
# On Pi (single SSH session, foreground):
ssh pi@<pi-ip>
cd ~/hackprinceton/pi && source .venv/bin/activate && python stream_server.py

# On compute-hub laptop, three terminals:

# Terminal 1 — backend
cd backend && source .venv/bin/activate
uvicorn server:app --host 0.0.0.0 --port 8000

# Terminal 2 — CV
cd pi && source ../backend/.venv/bin/activate
python capture_local.py --pi-ip <pi-ip>

# Terminal 3 — frontend
cd frontend && npm run dev -- --hostname 0.0.0.0
```

Phone-stand browser: `http://<laptop-lan-ip>:3000/status`.

### Networking

- **Pi on iPhone hotspot** — 2.4 GHz, no captive portal. Default configuration. Pi typically lands on `172.20.10.4`.
- **Venue WiFi fallback** — captive portals OK if the laptop clicks through; Pi inherits laptop's authenticated session via the laptop's position as the compute hub (MJPEG stream stays LAN-internal).
- **Ethernet direct** — supported via Windows ICS or macOS Internet Sharing (see RUNBOOK.md Mode B instructions). We didn't use this in final submission due to driver issues.

---

## 7. The build — phases and commits

### Phase A — Reliability floor
`/health` endpoint, honest startup banner, K2 placeholder guard, `_SAFE_FALLBACK` with `_model` attribution, per-call timeouts.

### Phase B — Contracts locked
`CONTRACTS.md` v1 authoritative schemas, 10 canonical JSON fixtures in `backend/examples/`, smoke-test harness (`test_scenarios.py`) — 6/6 pass target.

### Phase C ★ — Harden the reliability floor
- Localhost middleware gate on `/internal/*` — verified via `{"detail": "forbidden: /internal/* is localhost-only (saw 172.20.10.5)"}`.
- Structured logging (`rewind.log`, 3-level split, rotating).
- Query journal (`queries.jsonl`, append-only product corpus).
- `REWIND_DEMO_MODE` env flag — Claude-only + tightened timeout safety dial.

### Phase D — Data-layer reasoning quality
- `DISPLAY_LABELS` translation (ingest→query seam).
- `humanize_timestamp()` with 4 contextual buckets.
- K2 resilience (brace-balanced JSON extraction, inlined system prompt, no `response_format`, max_tokens=800).
- Per-request model override via `QueryIn.model` + segmented UI selector.

### Phase E+ — Integration layers
- Ambient state channel (`/ws/state`, `/internal/state`).
- `/agent/check` → ambient alert broadcast wiring.
- ElevenLabs TTS for answer + alert narration.
- Spatial grounding integration (cherry-picked from Sunghoo's `cv_tuning`).
- Laptop-offload mode (`stream_server.py` + `capture_local.py`).

### Repository state at submission

~30 commits across 11 merged PRs. Main is at `d087098`. Full stack verified: Pi streaming, compute hub running YOLO + backend + frontend, K2 primary answering with richer partial-information phrasing than Claude on multiple scenarios, ambient state channel broadcasting cleanly, observability artifacts writing to disk correctly.

---

## 8. Dependencies

| Layer | Key deps |
|---|---|
| Pi sensor | Python 3.13, opencv-python, numpy |
| Pi CV (Mode A) | + ultralytics (YOLOv8n), torch (CPU-only build from PyTorch CPU wheel index) |
| Compute hub CV | ultralytics, torch (w/ CUDA for RTX GPU), opencv-python, numpy |
| Backend | FastAPI, uvicorn[standard], pydantic, httpx, anthropic, python-dotenv |
| Frontend | Next.js 14.2.5, React 18.3, Tailwind 3.4, lucide-react, TypeScript 5.5 |
| Network | iPhone hotspot or venue WiFi or Ethernet+ICS |

---

## 9. Non-goals (explicitly out of scope)

- Cloud video storage / streaming
- Multi-room / multi-camera fusion
- Face recognition / person identification
- Historical analytics beyond last ~80 events
- Production SMS delivery (Twilio wired then deliberately removed — draft-only demo)
- SenseCAP custom firmware (deferred per 10 PM Friday cutoff; phone-stand `/status` fallback ships instead)
- Real-time video review UI (intentionally — breaks the privacy pitch)

---

## 10. Prize track alignments

- **Healthcare Hack** — medication adherence, elderly care, ADHD support. Demo centers on the meds scenario + Eragon alert.
- **Hardware Hack / Hardware + AI Hack** — Pi 4B + Logitech Brio 101 + cardboard enclosure; YOLO CV on device; sensor/hub architecture.
- **MLH Best Use of K2 Think V2** — K2 is primary LLM when configured, wired as core reasoning engine not side call. UI has a visible model selector that toggles routing. K2 answers demonstrate partial-information reasoning ("I saw pickup at X, haven't seen placement since").
- **MLH Best Use of ElevenLabs** — warm human voice for every answer + alert via `eleven_flash_v2_5`, served from backend as MP3s on `/audio/*`, auto-played by the ambient display.

Best Overall disqualifies track winners; we're aiming for two or three track wins rather than Best Overall.
