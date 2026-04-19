# Rewind — Split Pi/Laptop Pipeline

This doc describes the **two-box pipeline** actually used at demo time:

- `stream_server.py` runs on the **Raspberry Pi** — raw MJPEG camera stream, no ML.
- `capture_local.py` runs on the **laptop** — pulls the stream, runs YOLOv8 + ByteTrack, extracts events, writes to SQLite, broadcasts to the FastAPI backend.

> The older `capture.py` does *everything* on the Pi. It still works but the Pi 4B can't hit the target fps with YOLO on-device, so we split it. Use the split pipeline below unless you have a reason not to.

---

## Architecture at a glance

```
┌──────────────────────────────┐        MJPEG over HTTP         ┌──────────────────────────────────────┐
│ Raspberry Pi 4B              │   http://<pi-ip>:9090          │ Laptop (GPU)                         │
│                              │ ─────────────────────────────► │                                      │
│  stream_server.py            │                                │  capture_local.py                    │
│   • OpenCV VideoCapture(0)   │                                │   • cv2.VideoCapture(stream_url)     │
│   • JPEG encode @ ~21 fps    │                                │   • YOLOv8n + ByteTrack              │
│   • multipart/x-mixed-replace│                                │   • Event extractor                  │
└──────────────────────────────┘                                │   • sqlite3 → rewind.db              │
                                                                │   • thumbs/ (blurred 128×72 JPEGs)   │
                                                                │   • POST /internal/event_added ─────►│── FastAPI backend
                                                                └──────────────────────────────────────┘
```

- **Pi job:** be a dumb camera. Capture frames, JPEG-encode, serve.
- **Laptop job:** inference, tracking, event logic, persistence, broadcast.

---

## What each script actually does

### `stream_server.py` (Pi)

- Opens `CAMERA_INDEX = 0` at `640×480`, target `21 fps`.
- Background thread (`capture_loop`) grabs frames and JPEG-encodes them (quality 80) into a shared `_current_frame` buffer guarded by a lock.
- Main thread runs an `HTTPServer` on `0.0.0.0:9090` with an `MJPEGHandler`. Any GET returns a `multipart/x-mixed-replace; boundary=frame` stream. The handler sleeps `1/21` s between frames.
- No database, no ML, no broadcast — just pixels over HTTP.

### `capture_local.py` (Laptop)

- CLI: `--pi-ip`, `--port` (9090), `--model` (yolov8n.pt), `--show` (live cv2 window).
- Opens `cv2.VideoCapture("http://<pi-ip>:9090")`, reconnects on read failure.
- Every frame:
  1. `model.track(..., tracker="bytetrack.yaml")` → boxes + persistent track IDs.
  2. Filter to `HERO_OBJECTS` (phone, bottle, remote, book, backpack, person) above per-class confidence floors.
  3. Filter `SURFACES` (`dining table` → "the desk", `chair` → "the chair") for spatial grounding.
  4. `EventExtractor.step(...)` produces events:
     - `object_placed` / `person_entered` after `PRESENCE_FRAMES = 12`.
     - `object_picked_up` / `person_left` after `ABSENCE_FRAMES = 41`.
     - `action_detected` for `taking_pills` (bottle, upper third), `using_phone` (cell phone, upper third), `reading` (notebook, middle third). Debounced 8 s each.
  5. Save a blurred 128×72 thumbnail (except for `person_left`).
  6. Insert row into `rewind.db` (`events` table, auto-migrates to add `location` column).
  7. POST to `http://127.0.0.1:8000/internal/event_added`. Failures are swallowed.
- Paces the loop to `TARGET_FPS = 21`; prints actual fps every 3 s.

---

## Running the pipeline

### 1. Pi — start the stream server

SSH into the Pi, then:

```bash
cd ~/path/to/hackprinceton/pi
python -m venv .venv && source .venv/bin/activate   # first time only
pip install -r requirements.txt                      # first time only
python stream_server.py
```

Expected output:

```
[stream] camera open @ 640x480 target 21fps
[stream] serving MJPEG on http://0.0.0.0:9090
```

Sanity check from another machine on the same network — open `http://<pi-ip>:9090` in a browser; you should see the live feed.

Find the Pi's IP with `hostname -I` on the Pi, or `ip a`.

On Pi OS Bookworm without a venv, append `--break-system-packages` to the `pip install`.

### 2. Laptop — start the backend (optional but recommended)

In a separate terminal on the laptop, from the repo root:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

If the backend is offline, `capture_local.py` still runs — broadcast calls fail silently and events are still written to SQLite.

### 3. Laptop — start the capture client

In another terminal on the laptop, from the `pi/` directory:

```bash
cd pi
python -m venv .venv && source .venv/bin/activate    # first time only
pip install -r requirements-laptop.txt                # first time only — full YOLO stack
python capture_local.py --pi-ip <pi-ip>               # e.g. 172.20.10.3
```

#### Finding `<pi-ip>`

Pick whichever method you have easiest access to — any one of these works.

**A. From the Pi itself** (most reliable — keyboard/monitor or existing SSH session):

```bash
hostname -I          # prints all interface IPs, space-separated
# or, more detail:
ip -4 addr show      # look for inet on wlan0 (Wi-Fi) or eth0 (Ethernet)
```

The first IPv4 in `hostname -I` is almost always the one you want. Ignore `127.0.0.1` (loopback) and `169.254.x.x` (link-local, means DHCP failed).

**B. From your laptop, scanning the network** (if you don't have console access to the Pi):

```bash
# macOS: requires nmap — `brew install nmap`
nmap -sn 192.168.1.0/24 | grep -i -B2 raspberry

# Or try hostname resolution — works if your router/mDNS is cooperating:
ping raspberrypi.local        # most common default hostname
ping <your-pi-hostname>.local # whatever you set in raspi-config
```

Replace `192.168.1.0/24` with your actual subnet — check it with `ifconfig | grep "inet " | grep -v 127.0.0.1` on the laptop and swap the last octet for `0/24`.

**C. From the router admin page:** log into your router (usually `http://192.168.1.1` or `http://192.168.0.1`) → "Connected devices" / "DHCP clients" → find the Pi by hostname or MAC (Raspberry Pi MACs start with `B8:27:EB`, `DC:A6:32`, `D8:3A:DD`, or `E4:5F:01`).

**D. iPhone hotspot** (common at hackathons): open **Settings → Personal Hotspot → Family Sharing / Connections**, or on some iOS versions tap the hotspot row to see connected devices. The Pi will be in the `172.20.10.x` range.

**E. Android hotspot:** **Settings → Network & Internet → Hotspot & tethering → Wi-Fi hotspot → Connected devices**. Range is usually `192.168.43.x` or `192.168.x.x`.

**Confirm it works** from the laptop before launching the capture client:

```bash
curl -I http://<pi-ip>:9090       # expect HTTP/1.0 200 OK, content-type multipart/...
```

Or just open `http://<pi-ip>:9090` in a browser — you should see the live MJPEG feed.

> If `curl` hangs, the laptop and Pi aren't on the same network (common failure: laptop on home Wi-Fi, Pi on the hotspot, or vice versa), or `stream_server.py` isn't running yet.

Useful flags:

| Flag | Default | Purpose |
|---|---|---|
| `--pi-ip` | `172.20.10.3` | Pi's LAN IP |
| `--port` | `9090` | Must match `STREAM_PORT` in `stream_server.py` |
| `--model` | `yolov8n.pt` | Swap in a larger YOLO model if you have the GPU for it (see [Model options](#yolo-model-options)) |
| `--show` | off | Opens a cv2 window with bounding boxes; press `q` to quit |

Expected output:

```
[rewind] loading yolov8n.pt...
[rewind] connecting to Pi stream at http://172.20.10.3:9090...
[rewind] running. Ctrl-C to quit.
[fps] 20.8
[event 1] 14:32:07 object_placed       bottle               track=3 @ the desk
[event 2] 14:32:15 action_detected     taking_pills         track=3
...
```

### 4. Stop

- `Ctrl-C` on the laptop first (`capture_local.py`), then on the Pi (`stream_server.py`).

---

## Order-of-operations summary

1. On the Pi: `python stream_server.py` — must be up **before** step 3.
2. On the laptop (optional): `uvicorn main:app ...` in `backend/`.
3. On the laptop: `python capture_local.py --pi-ip <pi-ip>`.

The Pi and laptop must be on the **same network**, and the laptop must be able to reach the Pi on TCP 9090. If you're hotspot-sharing from a phone, `<pi-ip>` is whatever the phone DHCPed to the Pi (`172.20.10.x` on iOS hotspots).

---

## YOLO model options

The `--model` flag accepts any Ultralytics-compatible weights file. Ultralytics will auto-download the official ones on first use and cache them next to your script (so `yolov8s.pt`, `yolo11m.pt`, etc. appear in `pi/` after the first run).

Defaults ship with `yolov8n.pt` in the repo. Swap up the ladder as long as the laptop can still hold ~21 fps — watch the `[fps] ...` log line.

### YOLOv8 family (current default, stable)

| Weights | Params | Approx. speed on a laptop GPU | When to use |
|---|---|---|---|
| `yolov8n.pt` | ~3.2 M | **fastest** | Default. Pi demo, CPU-only laptops, or when fps drops |
| `yolov8s.pt` | ~11 M | fast | Better recall on small objects (pills, keys) — usually free on any modern dGPU |
| `yolov8m.pt` | ~26 M | moderate | Noticeably better on cluttered scenes; needs a real GPU (e.g. RTX 3060+) |
| `yolov8l.pt` | ~44 M | slow | Diminishing returns; only if `m` still misses things |
| `yolov8x.pt` | ~68 M | slowest | Overkill for demo; will likely drop below 21 fps |

### YOLO11 family (newer, same API)

If you want the most accurate model Ultralytics currently ships, use YOLO11. Same CLI, same class labels (COCO), just newer weights:

| Weights | Notes |
|---|---|
| `yolo11n.pt` | Nano — roughly matches `yolov8s` accuracy at nano speed |
| `yolo11s.pt` | Good default upgrade from `yolov8n` |
| `yolo11m.pt` | Strong accuracy bump; still real-time on a decent GPU |
| `yolo11l.pt` | Large |
| `yolo11x.pt` | Extra-large |

### Examples

```bash
# Default (nano, fastest)
python capture_local.py --pi-ip 172.20.10.3

# Slight accuracy bump, still fast
python capture_local.py --pi-ip 172.20.10.3 --model yolov8s.pt

# Best balance on a decent GPU
python capture_local.py --pi-ip 172.20.10.3 --model yolo11m.pt

# Use a custom / fine-tuned checkpoint
python capture_local.py --pi-ip 172.20.10.3 --model ./runs/detect/train/weights/best.pt
```

### Things to watch when upgrading

- **fps:** if `[fps]` drops well below 21, the model is too heavy — detections will lag the actual scene and events will fire late.
- **Confidence floors:** larger models are more confident; the `HERO_OBJECTS` floors in `capture_local.py` may need to be raised to avoid extra spurious detections.
- **Label set:** all `yolov8*` and `yolo11*` default weights are trained on COCO, so the existing `HERO_OBJECTS` / `SURFACES` keys stay valid. A custom checkpoint trained on a different dataset will need those dicts retuned to its label names.
- **GPU/CPU:** Ultralytics will auto-pick CUDA → MPS → CPU. On CPU only, stick with `yolov8n.pt` or `yolo11n.pt`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `camera failed to open` on Pi | Wrong camera index / no USB cam | Set `CAMERA_INDEX = 1` or `2`; `v4l2-ctl --list-devices` |
| Laptop: `cannot open stream at ...` | Pi not reachable, wrong IP, firewall | Curl `http://<pi-ip>:9090` from laptop; check Pi's `hostname -I` |
| `[rewind] stream read failed, reconnecting...` loops | Pi network flaky or `stream_server.py` crashed | Restart `stream_server.py`; client auto-reconnects |
| fps way below 21 | Network bottleneck or CPU-only YOLO on laptop | Lower `TARGET_FPS`, confirm CUDA/MPS is active, or use `yolov8n.pt` (smallest) |
| No events despite seeing the stream | Confidence floors too high | Log raw detections before the `HERO_OBJECTS` filter; tune `HERO_OBJECTS` values |
| Broadcast not landing in backend | Backend not on `127.0.0.1:8000` | Start uvicorn; confirm `SERVER_BASE` in `capture_local.py` |

---

## Data artifacts (all on the laptop)

- `rewind.db` — SQLite, `events` table. Query:
  ```bash
  sqlite3 rewind.db "SELECT id, ts, event_type, object, location FROM events ORDER BY ts DESC LIMIT 20;"
  ```
- `thumbs/` — blurred 128×72 JPEGs, named `<ts_ms>.jpg`. Deliberately unreadable for privacy.

Schema (auto-created/migrated by `init_db()`):

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  event_type TEXT NOT NULL,
  object TEXT NOT NULL,
  track_id INTEGER,
  bbox TEXT,
  thumb_path TEXT,
  location TEXT
);
```

Broadcast payload (see `backend/` for the consumer):

```json
POST http://127.0.0.1:8000/internal/event_added
{
  "id": 42,
  "ts": 1713000000.0,
  "event_type": "object_placed",
  "object": "bottle",
  "track_id": 17,
  "thumb_path": "thumbs/1713000000000.jpg",
  "location": "the desk"
}
```
