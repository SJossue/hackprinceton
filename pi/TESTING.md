# Rewind — Pipeline Testing Guide

How to validate the split pipeline (`stream_server.py` on Pi + `capture_local.py` on laptop) is actually working: what to do with your hands, what events you should see, and how to tune detection when things miss.

> Reminder: `stream_server.py` alone produces **no events** — it just streams pixels. Event logic lives in `capture_local.py`. "Testing the stream server" in practice means running the full pipeline and watching the laptop logs.

---

## 0. Pre-flight (do this once before any real testing)

Before you try to trigger events, confirm the stream and the model are both healthy. Most "the event didn't fire" bugs are actually "the model never saw the frame."

1. **Stream is live**
   - On the laptop: open `http://<pi-ip>:9090` in a browser. You should see smooth 640×480 video, not a frozen image.
   - If it's stuttering below ~10 fps, the rest of the testing will be unreliable — fix that first (see [Troubleshooting](#troubleshooting)).

2. **Capture client is processing frames**
   - Run with the live window so you can see exactly what the model sees:
     ```bash
     python capture_local.py --pi-ip <pi-ip> --show
     ```
   - Log line `[fps] 20.x` should print every ~3s. Anything under ~15 fps will delay events and may break action detection (the upper/middle region is computed per frame — noisy low fps makes it flicker).

3. **Lighting + framing**
   - Frame yourself so your full torso is visible (hero actions depend on the person bbox being accurate).
   - Avoid backlight — a window behind you will silhouette everything and kill recall.
   - Put the test objects against a contrasting background (a dark phone on a black desk won't detect).

---

## 1. Events you should see, and how to trigger each

The event extractor in `capture_local.py` emits exactly these `event_type` values. For each: what it means, how to trigger it, and the console line you should see.

Timing constants to keep in mind:

- `PRESENCE_FRAMES = 12` → ~0.6 s stable visibility before a placement/enter event fires.
- `ABSENCE_FRAMES = 41` → ~2 s gone before a pickup/leave event fires.
- `ACTION_DEBOUNCE_S = 8.0` → each named action can only fire once every 8 seconds.

### 1.1 `object_placed`

- **Means:** a hero object has been stably tracked for ~0.6 s.
- **Do:** pick up a tracked object off-camera, slowly bring it into frame, **hold it still for ~1 s** (don't just wave it through), then set it on the desk.
- **Expected log line:**
  ```
  [event N] HH:MM:SS object_placed        bottle               track=3 @ the desk
  ```
- **Test each hero object individually:** `cell phone`, `bottle`, `remote`, `book`, `backpack`. Confirm each one registers on its own before mixing them.

### 1.2 `object_picked_up`

- **Means:** a previously confirmed object has been missing for ~2 s.
- **Do:** after you've seen `object_placed`, pick the object up and take it completely out of frame. Keep it hidden for at least 3 s (the 2 s threshold plus buffer).
- **Expected log line:**
  ```
  [event N] HH:MM:SS object_picked_up     bottle               track=3 @ the desk
  ```
  The `location` is where it was *last seen*, so moving an object from the desk to the chair and hiding it should report `@ the desk` (the pre-pickup surface).

### 1.3 `person_entered`

- **Means:** a `person` track has been visible for ~0.6 s.
- **Do:** step out of frame entirely, wait ~3 s, then walk back in and stand still for ~1 s.
- **Expected log line:**
  ```
  [event N] HH:MM:SS person_entered       person               track=1
  ```
- Note the `person` confidence floor is **0.50** (higher than objects). If you sidle in at the edge of frame, it may miss — step fully in.

### 1.4 `person_left`

- **Means:** a confirmed `person` track has been missing for ~2 s.
- **Do:** after `person_entered`, fully exit the frame and stay out for ~3 s.
- **Expected log line:**
  ```
  [event N] HH:MM:SS person_left          person               track=1
  ```
- `person_left` events intentionally get **no thumbnail saved** (`capture_local.py:365`), so don't expect a new `thumbs/*.jpg` for these.

### 1.5 `action_detected` — `taking_pills`

- **Trigger rule:** `bottle` bbox center lands in the **upper third** of the `person` bbox.
- **Do:** hold a bottle (pill bottle, water bottle — any COCO `bottle`) up to face height like you're taking a sip or a pill. Keep your body facing the camera so the person bbox is tall.
- **Expected log line:**
  ```
  [event N] HH:MM:SS action_detected      taking_pills         track=5
  ```
- **Debounced 8 s** — fires once, then you need to wait before it fires again.

### 1.6 `action_detected` — `using_phone`

- **Trigger rule:** `cell phone` bbox center in the **upper third** of the `person` bbox.
- **Do:** hold your phone up near your face like you're taking a selfie or reading a text near eye level. Don't hold it at waist — that lands in the middle/lower region and won't trigger.
- **Expected log line:**
  ```
  [event N] HH:MM:SS action_detected      using_phone          track=5
  ```

### 1.7 `action_detected` — `reading`

- **Trigger rule (as coded):** an object with label `notebook` in the **middle third** of the person bbox.
- **⚠ Known quirk:** `notebook` is **not** in the `HERO_OBJECTS` dict in `capture_local.py` — only `book` is. So with the stock config, `reading` will *not* fire even if you hold a book at chest height. If you expected this to work, that's why. Either:
  - Test `using_phone` and `taking_pills` and skip `reading` for now, **or**
  - Add `"notebook"` (or change the `ACTION_RULES` entry to key on `"book"`) — but that's a code change, not a test step. Flag it to whoever owns `capture_local.py`.

### 1.8 Location grounding

- Every `object_placed` / `object_picked_up` event should have a `@ the desk` or `@ the chair` suffix if the object is sitting on / near one of those surfaces.
- **Test it:**
  - Place a bottle on the desk → `object_placed bottle @ the desk`.
  - Place a bottle on a chair → `object_placed bottle @ the chair`.
  - Place a bottle on the floor with no surface in view → `object_placed bottle` (no `@` suffix).
- If you see a hero object event with **no** location and a desk/chair is clearly visible, the surface isn't being detected — see [Tuning](#tuning-detection).

---

## 2. Minimum happy-path test script (do this in order)

Run through this to confirm every event type in one sitting:

1. Start with frame **empty** (no person, no hero objects).
2. Walk in → wait ~2 s → **expect** `person_entered`.
3. Bring a phone up to face level → hold 1 s → **expect** `using_phone`.
4. Lower the phone to desk, let go → wait 1 s → **expect** `object_placed cell phone @ the desk`.
5. Pick the phone back up and take it out of frame for 3 s → **expect** `object_picked_up cell phone @ the desk`.
6. Bring a bottle to face level → **expect** `taking_pills` + (eventually) `object_placed bottle`.
7. Place bottle on a chair → **expect** location to be `@ the chair` on the next pickup.
8. Walk out of frame for 3 s → **expect** `person_left`.

Cross-check the database after:

```bash
sqlite3 rewind.db "SELECT id, event_type, object, location FROM events ORDER BY id DESC LIMIT 20;"
```

You should see roughly 8–10 rows covering each event type at least once.

---

## 3. Troubleshooting

Work top-down — earlier issues mask later ones.

### Stream-level issues (Pi)

| Symptom | Cause | Fix |
|---|---|---|
| Browser at `http://<pi-ip>:9090` is black / frozen | `cv2.VideoCapture(0)` grabbed a different camera | Set `CAMERA_INDEX` to 1 or 2 in `stream_server.py`, or run `v4l2-ctl --list-devices` on the Pi |
| Stream connects but stutters badly | Pi CPU pegged / USB bandwidth | Lower `FRAME_W/FRAME_H` to 480×360; or lower `TARGET_FPS` to 10 |
| Browser works, but `curl -I http://<pi-ip>:9090` from laptop hangs | Laptop and Pi on different networks | Check both are on the same Wi-Fi/hotspot — see `PIPELINE.md` §Finding `<pi-ip>` |
| `stream_server.py` exits with `camera failed to open` | No USB cam plugged in, or held by another process | Reseat the cable; `sudo fuser /dev/video0` to find holders |

### Capture-client issues (laptop)

| Symptom | Cause | Fix |
|---|---|---|
| `[fps]` prints below ~10 | YOLO running on CPU, or stream is slow | Confirm GPU: `python -c "import torch; print(torch.cuda.is_available(), torch.backends.mps.is_available())"`. Drop to `yolov8n.pt` if on CPU |
| Live `--show` window opens but no boxes | Confidence floors too high | Temporarily lower `HERO_OBJECTS["cell phone"]` etc. to `0.10` and see if anything fires |
| Boxes flicker on/off on the object | Detection is borderline — misses cause miss_count to climb | Lower the class's confidence floor, or improve lighting/contrast |
| Track ID keeps changing for the same object | ByteTrack lost the track (motion too fast, or too long occluded) | Move the object more slowly; reduce camera motion blur (more light) |

### Event-level issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Object is clearly detected in `--show` window but no `object_placed` fires | Held it too briefly (<0.6 s) | Hold the object stationary for at least 1 s |
| `object_placed` fires but never `object_picked_up` | Object isn't fully out of frame for 2 s, or a different track ID resumed | Remove it completely; check `--show` for lingering box |
| `object_picked_up` fires with wrong `location` | Last surface assignment was stale | Put the object directly on top of the intended surface before pickup; make sure the surface is detected (orange box in `--show`) |
| `action_detected` never fires | Object not in the person's upper/middle third, or debounce still active | Hold the object up near your face (upper third of the person bbox); wait ≥8 s between attempts |
| Every movement fires a new `object_placed` for the same thing | Track is being re-created each time | This is a tracking failure — see "Track ID keeps changing" above |
| `person_entered` fires but `person_left` doesn't | You're partially in frame (edge of camera) | Step fully out; person conf floor is 0.50 and a half-visible person may still score above that |

### Broadcast / backend issues

| Symptom | Cause | Fix |
|---|---|---|
| Events logged to console but dashboard is empty | Backend not running | `uvicorn main:app --host 127.0.0.1 --port 8000` in the `backend/` folder |
| Events missing from `rewind.db` | DB path mismatch | `capture_local.py` writes to `rewind.db` **relative to its working dir**. `cd pi/` before launching so the path lines up |

---

## 4. Tuning detection

Once the pipeline runs end-to-end, these are the knobs that actually move the needle. All are in `capture_local.py`.

### Confidence floors (`HERO_OBJECTS` / `SURFACES`)

- Too high → misses. Too low → spurious detections and flicker.
- **Method:** run with `--show`, pick the problem class, and watch the printed `conf` in the live box. If real objects consistently score 0.30 and your floor is 0.40, lower it to 0.25. If random pixels are firing at 0.15, raise the floor to 0.30.

### Presence / absence thresholds (`EventExtractor.PRESENCE_FRAMES`, `ABSENCE_FRAMES`)

- Current: 12 / 41 frames at 21 fps → 0.6 s / 2 s.
- If events feel laggy in a live demo, drop `PRESENCE_FRAMES` to 6 (~0.3 s). Risk: more false positives from a momentary flicker.
- If single false detections are spawning ghost `object_placed` events, raise `PRESENCE_FRAMES` to 20.

### Action regions (`_detect_actions`)

- Upper third = `py1` to `py1 + h/3`. Middle third = `py1 + h/3` to `py1 + 2h/3`.
- If `taking_pills` fires when you're just holding the bottle at chest height, the upper third is too generous for your framing. Either stand further back (makes your bbox taller, so the upper third is smaller in absolute pixels) or tighten the region in code.

### Action debounce (`ACTION_DEBOUNCE_S`)

- 8 s means the same action only logs once per 8 s. Fine for a live demo, too aggressive for rapid testing. Lower to 2 s while testing, raise back to 8 s before the demo.

### Model choice

- Bigger model = better recall on small/occluded objects. See `PIPELINE.md` → YOLO model options. Good order to try: `yolov8n.pt` → `yolov8s.pt` → `yolo11s.pt` → `yolo11m.pt`.
- Watch the `[fps]` log — if you drop below ~15 fps, your action detection will get twitchy because the person bbox jitters frame-to-frame.

### Camera & scene (not code)

Usually the cheapest wins:

- **Light the subject.** A ring light or desk lamp aimed at the person + desk roughly doubles detection quality.
- **Clean background.** Fewer distractors → fewer spurious detections that steal track IDs.
- **Framing.** Keep the camera stable. Frame the full torso + desk in a single shot so the person bbox and object-on-desk events share a coordinate system.
- **Don't occlude with hands.** If you palm the phone, the model sees a hand, not a phone.

---

## 5. Sanity checks you can run anytime

```bash
# Count events by type — after a test session, every type should be > 0
sqlite3 rewind.db \
  "SELECT event_type, COUNT(*) FROM events GROUP BY event_type;"

# Watch events land in real time (run in a separate terminal)
watch -n 1 'sqlite3 rewind.db "SELECT id, datetime(ts, \"unixepoch\", \"localtime\"), event_type, object, location FROM events ORDER BY id DESC LIMIT 10;"'

# Confirm thumbnails are being written (should grow during a session)
ls thumbs/ | wc -l

# Confirm the backend actually received broadcasts
curl -s http://127.0.0.1:8000/events | head   # endpoint name depends on backend — adjust if needed
```

If `events` is growing but `thumbs/` isn't, the blur/save step is failing silently — check write permissions on `thumbs/`.

If `rewind.db` isn't growing at all, you're either not triggering any events or the DB is being written somewhere else (`pwd` when you launched `capture_local.py` matters — it's a relative path).
