# Rewind

> **Your home has a memory. Just ask.**

HackPrinceton 2026 submission — an ambient wall-mounted camera node that remembers *events*, not video, and answers natural-language questions about a room's past.

**Submission deadline: Sunday April 19, 8 AM.** No more pivots. Ship it.

---

## Start here (by role)

Jump straight into your folder. Each has a focused README with "what you own, how to run it, what done-by-2AM-Friday looks like."

| Owner | Folder | What it is |
|---|---|---|
| **Sunghoo** | [`pi/`](./pi) | CV pipeline on the Raspberry Pi — YOLOv8 + ByteTrack + event extractor + SQLite log |
| **Jossue** *(team lead)* | [`backend/`](./backend) | FastAPI server + LLM query layer (K2 primary, Claude failover) + Eragon proactive agent. Also owns Devpost, demo script, pitch. |
| **Jeeyan** | [`frontend/`](./frontend) | Next.js 14 command center — live event timeline, Web Speech voice I/O, agent alerts |
| **Ariji** | [`sensecap/`](./sensecap) + hardware | SenseCAP Indicator LVGL firmware (4-state ambient display), Grove button/LED wiring, cardboard enclosure, MLH hardware pickup |

**Shared references** (read once, return when needed):

- [`docs/PROJECT.md`](./docs/PROJECT.md) — full project bible: vision, architecture diagram, sprint plan, demo script, risks
- [`docs/TEAM_PITCH.md`](./docs/TEAM_PITCH.md) — 60-second alignment pitch to read at the start of the build
- [`docs/HARDWARE.md`](./docs/HARDWARE.md) — MLH hardware checklist + sanity checks
- [`docs/DEMO_SCRIPT.md`](./docs/DEMO_SCRIPT.md) — the 2-minute demo, verbatim, for rehearsal

---

## Architecture at a glance

```
┌──────────────── REWIND DEVICE (wall-mounted) ──────────────┐
│  Webcam ──► Raspberry Pi 4B ──► SenseCAP (USB serial)      │
│                │  capture.py (pi/)                         │
│                │  FastAPI   (backend/) ──► WS + HTTP       │
│                └──► Grove button / LED (GPIO)              │
└────────────────────────┬───────────────────────────────────┘
                         │ WiFi
                         ▼
            ┌────────────────────────┐
            │  Laptop — Next.js      │
            │  dashboard + Web       │
            │  Speech STT/TTS        │
            │  (frontend/)           │
            └────────────┬───────────┘
                         │ HTTPS (text only, never video)
                         ▼
               K2 Think V2  ⇄  Claude 4.7 failover
```

Full diagram and rationale: [`docs/PROJECT.md` § System Architecture](./docs/PROJECT.md#️-system-architecture).

---

## Quickstart — new machine, any role

```bash
git clone <this-repo> rewind && cd rewind
cp .env.example backend/.env               # fill in ANTHROPIC_API_KEY + K2_* keys
cp .env.example frontend/.env.local        # or cp frontend/.env.local.example
```

Then jump to your folder's README and follow its Run section.

**Backend + Pi (Jossue + Sunghoo share the Pi):**

```bash
# Backend
cd backend && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000 --reload

# Pi (separate shell on the Pi)
cd pi && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python capture.py
```

**Frontend (Jeeyan, on a laptop):**

```bash
cd frontend
npm install
npm run dev    # http://localhost:3000
```

---

## Integration contracts (don't change without a ping to the other owner)

These are the wires between people's code. Changing a field breaks a teammate's work.

### Pi → Backend (internal, localhost:8000)

`POST /internal/event_added` — `capture.py` fires this on each extracted event so the backend can broadcast it over WebSocket to connected dashboards.

```json
{
  "id": 42,
  "ts": 1713456789.12,
  "event_type": "object_placed",
  "object": "bottle",
  "track_id": 17,
  "thumb_path": "thumbs/1713456789120.jpg",
  "location": "the desk"
}
```

`location` is the surface the object was resolved to (spatial grounding — see [`pi/README.md`](./pi)). It may be `null` for person events or when no nearby surface was detected.

### Backend → Frontend

- `GET  /events?limit=80` → `EventRow[]` (initial load)
- `WS   /ws/events` → streams one `EventRow` JSON per message (live)
- `POST /query   { "question": string }` → `{ answer, confidence, event_ids, _model }`
- `POST /agent/check` → `Alert[]`

### Pi → SenseCAP (USB serial, 115200 baud, `/dev/ttyACM0`)

JSON-lines — see [`sensecap/README.md`](./sensecap/README.md).

---

## Track strategy (prize stack)

Main: **Best Healthcare Hack**. Secondary: Hardware+AI, Eragon (Mac Mini), K2 Think V2, Telora. Stretch: Regeneron Clinical Trials, Best Overall. Full rationale in `docs/PROJECT.md § Track Strategy`.

---

## Team rules (non-negotiable)

1. **No pivots.** We ship Rewind or we ship nothing.
2. **Friday night is solo.** Each of us ships our piece by 2 AM — no integration tonight.
3. **Stuck 45+ min → ask.** Teammate or AI. Don't burn an hour alone.
4. **The demo is the product.** If a feature doesn't appear in the 2-minute demo, it's out of scope.
5. **Never commit `.env` or `rewind.db` or `thumbs/`.** Privacy-by-design is the pitch; don't break it with a bad commit.
