# Recall

> **Your home has a quiet memory. Just ask.**

HackPrinceton 2026 submission. Recall is an ambient episodic-memory companion for a physical space — a tiger mascot that sits on a shelf, watches the room, and remembers *events* (not video). Two user-facing surfaces — a warm editorial **laptop dashboard** and a **phone-stand ambient display** — let anyone in the house ask what happened in plain English.

---

## Product in one paragraph

The tiger houses a Raspberry Pi 4 and a Logitech Brio camera. The Pi streams frames over the local network — no ML on the Pi, no recording. A laptop runs YOLOv8 + ByteTrack on the stream, reduces detections to structured events (*object placed, person entered, pills taken*) tagged with a **room** and a **surface** ("on the desk in the Living Room"), and writes them to SQLite. Ask Recall a question and the backend feeds recent events to **K2 Think V2** (with Claude Opus 4.7 as an automatic failover), which answers in plain English. Answers are spoken through ElevenLabs, and the phone-stand beside the tiger animates a particle cloud through *idle → listening → thinking → answer* states in real time. **Video never leaves the tiger.** Only short text events do.

---

## Architecture

```
          ┌──────────────── TIGER (on a shelf) ─────────────────┐
          │                                                     │
          │     Logitech Brio ──► Raspberry Pi 4B               │
          │                       stream_server.py              │
          │                       MJPEG over HTTP :9090         │
          └────────────────────────┬────────────────────────────┘
                                   │  (WiFi, frames only — no ML on the Pi)
                                   ▼
          ┌──────────────── LAPTOP (compute hub) ───────────────┐
          │                                                     │
          │  capture_local.py     YOLOv8n + ByteTrack           │
          │        │              per-frame detections          │
          │        ▼                                            │
          │  EventExtractor ──► SQLite (rewind.db)              │
          │        │              + POST /internal/event_added  │
          │        ▼                                            │
          │  FastAPI backend (server.py)                        │
          │        │  /query → K2 Think V2 ⇄ Claude 4.7         │
          │        │  /events, /agent/check                     │
          │        │  /ws/events (dashboard push)               │
          │        │  /ws/state  (ambient-display push)         │
          │        ▼                                            │
          │  ElevenLabs TTS for answers + alerts                │
          └──────┬──────────────────────────┬───────────────────┘
                 │                          │
                 ▼                          ▼
      ┌──────────────────────┐   ┌──────────────────────────┐
      │ Next.js dashboard    │   │ /status ambient display  │
      │ (http://host:3000)   │   │ (phone on a stand)       │
      │ warm cream, serif,   │   │ Three.js particle cloud  │
      │ floor-plan of rooms, │   │ morphs: idle/listening/  │
      │ journal of moments   │   │ thinking/answer/alert    │
      └──────────────────────┘   └──────────────────────────┘
```

**Only text events cross any wire.** The Pi never ships raw video past the local network, and the laptop never ships video anywhere — LLM calls carry short text event logs, not pixels.

---

## Tech stack

| Layer | Stack |
|---|---|
| **Tiger sensor** | Raspberry Pi 4B, Logitech Brio 4K, OpenCV (headless), MJPEG over HTTP |
| **Laptop CV** | YOLOv8n + ByteTrack (Ultralytics), custom `EventExtractor`, SQLite |
| **Backend** | Python 3.13, FastAPI, Uvicorn, WebSockets (`/ws/events`, `/ws/state`) |
| **Reasoning** | K2 Think V2 (MBZUAI) primary · Claude Opus 4.7 failover · repair-retry + safe fallback |
| **Voice** | ElevenLabs TTS (runtime-generated MP3, never committed) |
| **Dashboard** | Next.js 14, TypeScript, Tailwind, Fraunces + Manrope, warm editorial palette |
| **Ambient display** | Next.js `/status` route, Three.js particle cloud (900 particles), WS-driven |
| **Privacy** | Video stays on LAN · thumbnails blurred 128×72 · `.env` never committed |

---

## Quickstart — demo recipe

You'll need three terminals on the laptop plus one SSH session to the Pi. Start in this order — each step depends on the previous.

### 0. One-time setup

```bash
git clone https://github.com/SJossue/hackprinceton.git recall && cd recall
cp .env.example backend/.env                  # fill in ANTHROPIC_API_KEY + K2_* + ELEVENLABS_API_KEY
# (frontend/.env.local is optional — only needed if dashboard runs on a
#  different machine than the backend; set NEXT_PUBLIC_REWIND_API there)
```

### 1. Pi — stream server

SSH into the Pi, then:

```bash
cd ~/hackprinceton/pi
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # minimal: opencv-headless + numpy
python stream_server.py                  # foreground — leave it running
```

Expect:
```
[stream] camera open @ 640x480 target 21fps
[stream] serving MJPEG on http://0.0.0.0:9090
```

Open `http://<pi-ip>:9090` in a browser to confirm live video.

### 2. Laptop — backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8000
```

The startup banner shows K2/Claude/ElevenLabs config status and DB event count.

### 3. Laptop — capture client (YOLO runs here, not on the Pi)

```bash
cd pi                                                    # same pi/ folder — different venv
python -m venv .venv && source .venv/bin/activate        # laptop-local venv
pip install -r requirements-laptop.txt                   # full YOLO + torch stack
python capture_local.py --pi-ip <pi-ip> --room "Living Room"
```

Expect `[fps] 20.x` every ~3s and `[event N] ...` lines as the Brio sees things.

### 4. Laptop — frontend

```bash
cd frontend
npm install
npm run dev                              # http://localhost:3000
```

Open `http://localhost:3000` for the dashboard and `http://localhost:3000/status` on the phone (full-screen it) for the ambient display.

---

## Live vs demo mode

By default the dashboard shows **only real data**. If the backend is unreachable, the journal renders an empty state ("*The house is still quiet.*") rather than spawning fake activity. The connection pill in the header reads `live` / `offline`.

For offline UI tinkering, set `NEXT_PUBLIC_REWIND_MOCK_MODE=1` in `frontend/.env.local` and mocks resume. The pill then reads `demo data` so you never confuse fabricated events for real ones.

The backend has a separate `REWIND_DEMO_MODE` env flag that skips K2 entirely and tightens Claude timeouts — useful for high-stakes demos where latency must stay bounded.

---

## Integration contracts

These are the wires between components. Changing a field breaks something downstream.

### Event schema (SQLite · `GET /events` · `/ws/events` · capture payload)

```json
{
  "id": 42,
  "ts": 1713456789.12,
  "event_type": "object_placed",
  "object": "bottle",
  "track_id": 17,
  "thumb_path": "thumbs/1713456789120.jpg",
  "location": "the desk",
  "room": "Living Room"
}
```

`location` and `room` are both optional — `location` (surface grounding) is only present for object events; `room` is set per-capture-instance via `capture_local.py --room "..."`. The LLM receives *"bottle placed on the desk in the Living Room at 8:02"* naturally in its context.

### Ambient state channel (`/ws/state` · `POST /internal/state`)

```json
{ "state": "idle | listening | thinking | answer | alert", "text": "optional for answer/alert", "audio_url": "optional mp3" }
```

The phone's `/status` page subscribes and morphs its particle cloud on each state change. When `/query` is hit, the backend automatically broadcasts `thinking` → `answer`. The dashboard's mic button bridges `listening` → `idle`.

### Backend → dashboard

- `GET  /events?limit=80` → `EventRow[]`
- `POST /query { question, model? }` → `{ answer, confidence, event_ids, _model, audio_url? }`
- `POST /agent/check` → `Alert[]` (also broadcasts `alert` state to the phone)
- `GET  /thumb/<path>` → JPEG (blurred 128×72 thumbnails)
- `GET  /audio/<filename>.mp3` → ElevenLabs-generated audio

---

## Repo layout

| Path | What it is |
|---|---|
| `pi/stream_server.py` | Runs on the Pi inside the tiger — MJPEG source, no ML |
| `pi/capture_local.py` | Runs on the laptop — YOLO + ByteTrack + event extraction + DB + broadcast |
| `pi/requirements.txt` | Minimal Pi deps (opencv-headless + numpy) |
| `pi/requirements-laptop.txt` | Full laptop deps (ultralytics + torch + httpx) |
| `pi/PIPELINE.md` · `pi/TESTING.md` | Split-pipeline docs + event-triggering test script |
| `backend/server.py` | FastAPI app: `/events`, `/query`, `/agent/check`, WS channels |
| `backend/query.py` | LLM query engine: K2 primary, Claude failover, safe fallback |
| `backend/agent.py` | Proactive caregiver agent (medication watch → drafted SMS) |
| `backend/tts.py` | ElevenLabs TTS wrapper |
| `backend/CONTRACTS.md` | Wire-level schema contracts |
| `frontend/app/page.tsx` | Dashboard (warm editorial, journal, floor plan, Ask) |
| `frontend/app/status/page.tsx` | Ambient particle display for the phone stand |
| `frontend/app/globals.css` | Fraunces + Manrope, cream/ochre/sage/clay palette |
| `docs/TECHNICAL_OVERVIEW.md` | Full architecture + phase log |
| `docs/VIDEO_NARRATIVE.md` | 60–90s pitch video script (tiger-as-device concept) |
| `RUNBOOK.md` | Deploy/restart/verify recipes |

---

## Prize tracks

| Track | What we built for it |
|---|---|
| **Best Healthcare Hack** | Medication watch + warm voice reassurance for older adults and their caregivers |
| **Hardware + AI** | Pi-in-tiger sensor + phone-stand ambient display + dual-LLM reasoning |
| **Eragon (Mac Mini)** | Proactive agent (`backend/agent.py`) — drafts human-reviewable SMS when a scheduled med is missed. Draft-only, never auto-sends |
| **K2 Think V2** | K2 is the default reasoning engine; per-query model selector in the UI shows K2 vs Claude side-by-side |

---

## Privacy posture

1. **The Pi never transmits video off the local network.** Only short JSON events cross any wire beyond the LAN.
2. **Thumbnails are blurred at capture time** (128×72, Gaussian 9×9) and are the *only* visual artifact stored. They exist so the dashboard can show "last seen here" context, not to reconstruct scenes.
3. **`.env`, `rewind.db`, `thumbs/`, ElevenLabs MP3s, and `queries.jsonl` are all `.gitignore`d.** Secrets and user data never reach the repo.
4. **The proactive agent drafts, it never sends.** Caregiver SMS goes into the dashboard for human review before any delivery.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pi boots but no stream at `:9090` | Check `lsusb | grep -i logitech`; swap to blue USB-3 port; verify `/dev/video0` exists |
| `ImportError: libGL.so.1` on Pi | You installed `opencv-python` instead of `opencv-python-headless` — the minimal `pi/requirements.txt` has the right one |
| `[fps]` on capture client drops below 15 | CPU-only laptop — confirm CUDA with `torch.cuda.is_available()`; downsize to `yolov8n.pt` |
| Dashboard shows no events with backend running | Empty DB is the expected initial state. Wave an object in front of the tiger; watch `capture_local.py` logs for `[event N]` |
| Header pill says `offline` | Backend isn't reachable — check `curl http://localhost:8000/health`; confirm `NEXT_PUBLIC_REWIND_API` matches the backend host |
| Phone `/status` animates but text is hard to read | Fixed — `labelIn`/`idleIn` keyframes now land at correct opacity; vignette lightened |

---

## Team

| Role | Owner |
|---|---|
| Team lead · backend · LLM pipeline · agent · Devpost | Jossue |
| Raspberry Pi / CV pipeline | Sunghoo |
| Frontend dashboard + ambient display | Jeeyan |
| Hardware + tiger enclosure | Ariji |

Built at HackPrinceton 2026.
