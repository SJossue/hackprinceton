"""
Rewind — Laptop-side capture client + YOLO inference.
Pulls MJPEG stream from Pi, runs YOLOv8 locally with better GPU,
and does all event extraction + DB + broadcasting.

Run:  python capture_local.py --pi-ip 172.20.10.3
Deps: opencv-python, ultralytics, numpy, httpx
"""

from __future__ import annotations

import argparse
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import cv2
import httpx
import numpy as np
from ultralytics import YOLO

# ---------- Config ---------------------------------------------------------

DB_PATH = Path("rewind.db")
THUMB_DIR = Path("thumbs")
THUMB_DIR.mkdir(exist_ok=True)
SERVER_BASE = "http://127.0.0.1:8000"

HERO_OBJECTS = {
    "cell phone": 0.25,
    "bottle": 0.22,
    "remote": 0.25,
    "book": 0.25,
    "backpack": 0.25,
    "person": 0.50,
}

SURFACES = {
    "dining table": ("the desk",  0.2),
    "chair":        ("the chair", 0.2),
}

TARGET_FPS = 21
TRACKER_CFG = "bytetrack.yaml"

# ---------- Domain types ---------------------------------------------------

@dataclass
class TrackedDetection:
    track_id: int
    label: str
    conf: float
    bbox: tuple[int, int, int, int]

@dataclass
class Event:
    ts: float
    event_type: str
    object: str
    track_id: int | None
    bbox: tuple[int, int, int, int] | None
    thumb_path: str | None
    location: str | None = None
    # Room-level tag — supplied per-capture-instance via `--room`. A camera
    # watches exactly one room, so every event it emits gets the same tag.
    # Separate from `location` (sub-room surface: "the desk"), because rooms
    # are cross-camera and surfaces are per-camera.
    room: str | None = None

@dataclass
class SurfaceDetection:
    label: str
    pretty: str
    bbox: tuple[int, int, int, int]

# ---------- DB -------------------------------------------------------------

def init_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("""
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        event_type TEXT NOT NULL,
        object TEXT NOT NULL,
        track_id INTEGER,
        bbox TEXT,
        thumb_path TEXT,
        location TEXT,
        room TEXT
      )
    """)
    cols = {row[1] for row in conn.execute("PRAGMA table_info(events)")}
    if "location" not in cols:
        conn.execute("ALTER TABLE events ADD COLUMN location TEXT")
    if "room" not in cols:
        conn.execute("ALTER TABLE events ADD COLUMN room TEXT")
    conn.commit()
    return conn

def insert_event(conn: sqlite3.Connection, ev: Event) -> int:
    cur = conn.execute(
        "INSERT INTO events (ts, event_type, object, track_id, bbox, thumb_path, location, room) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (ev.ts, ev.event_type, ev.object, ev.track_id,
         str(ev.bbox) if ev.bbox else None, ev.thumb_path, ev.location, ev.room),
    )
    conn.commit()
    return cur.lastrowid

# ---------- Thumbnail ------------------------------------------------------

def save_thumb(frame: np.ndarray, event_ts: float) -> str:
    small = cv2.resize(frame, (128, 72), interpolation=cv2.INTER_AREA)
    blurred = cv2.GaussianBlur(small, (9, 9), 0)
    path = THUMB_DIR / f"{int(event_ts*1000)}.jpg"
    cv2.imwrite(str(path), blurred, [cv2.IMWRITE_JPEG_QUALITY, 60])
    return str(path)

# ---------- Spatial grounding ----------------------------------------------

def _iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    area_a = max(1, (ax2 - ax1) * (ay2 - ay1))
    area_b = max(1, (bx2 - bx1) * (by2 - by1))
    return inter / (area_a + area_b - inter)

def _bbox_center(b: tuple[int, int, int, int]) -> tuple[int, int]:
    x1, y1, x2, y2 = b
    return ((x1 + x2) // 2, (y1 + y2) // 2)

def resolve_location(
    obj_bbox: tuple[int, int, int, int],
    surfaces: list[SurfaceDetection],
) -> str | None:
    if not surfaces:
        return None
    ox1, oy1, ox2, oy2 = obj_bbox
    obj_center = ((ox1 + ox2) // 2, (oy1 + oy2) // 2)

    containing = [
        s for s in surfaces
        if s.bbox[0] <= obj_center[0] <= s.bbox[2]
        and s.bbox[1] <= obj_center[1] <= s.bbox[3]
    ]
    if containing:
        containing.sort(key=lambda s: (s.bbox[2] - s.bbox[0]) * (s.bbox[3] - s.bbox[1]))
        return containing[0].pretty

    best = max(surfaces, key=lambda s: _iou(obj_bbox, s.bbox))
    if _iou(obj_bbox, best.bbox) > 0.05:
        return best.pretty

    return None

# ---------- Action rules ---------------------------------------------------

ACTION_RULES: tuple[tuple[str, str, str], ...] = (
    ("taking_pills", "bottle", "upper"),
    ("using_phone", "cell phone", "upper"),
    ("reading", "notebook", "middle"),
)

ACTION_DEBOUNCE_S = 8.0

# ---------- Event extractor ------------------------------------------------

class EventExtractor:
    PRESENCE_FRAMES = 12    # ~0.6s @ 20.5fps
    ABSENCE_FRAMES = 41     # ~2s @ 20.5fps

    def __init__(self) -> None:
        self.known_tracks: dict[int, str] = {}
        self.seen_count: dict[int, int] = {}
        self.miss_count: dict[int, int] = {}
        self.last_bbox: dict[int, tuple[int, int, int, int]] = {}
        self.last_location: dict[int, str | None] = {}
        self.confirmed: set[int] = set()
        self.last_action_ts: dict[str, float] = {}

    def step(
        self,
        detections: list[TrackedDetection],
        surfaces: list[SurfaceDetection] | None = None,
    ) -> list[Event]:
        events: list[Event] = []
        now = time.time()
        surfaces = surfaces or []

        seen_ids = {d.track_id: d for d in detections}

        for tid, det in seen_ids.items():
            self.known_tracks[tid] = det.label
            self.seen_count[tid] = self.seen_count.get(tid, 0) + 1
            self.miss_count[tid] = 0
            self.last_bbox[tid] = det.bbox
            if det.label != "person":
                self.last_location[tid] = resolve_location(det.bbox, surfaces)
            if tid not in self.confirmed and self.seen_count[tid] >= self.PRESENCE_FRAMES:
                self.confirmed.add(tid)
                etype = "person_entered" if det.label == "person" else "object_placed"
                loc = None if det.label == "person" else self.last_location.get(tid)
                events.append(Event(now, etype, det.label, tid, det.bbox, None, loc))

        for tid in list(self.confirmed):
            if tid not in seen_ids:
                self.miss_count[tid] = self.miss_count.get(tid, 0) + 1
                self.seen_count[tid] = 0
                if self.miss_count[tid] >= self.ABSENCE_FRAMES:
                    label = self.known_tracks.get(tid, "unknown")
                    etype = "person_left" if label == "person" else "object_picked_up"
                    loc = None if label == "person" else self.last_location.get(tid)
                    events.append(Event(now, etype, label, tid,
                                       self.last_bbox.get(tid), None, loc))
                    self.confirmed.discard(tid)

        events.extend(self._detect_actions(detections, now))
        return events

    def _detect_actions(
        self,
        detections: list[TrackedDetection],
        now: float,
    ) -> list[Event]:
        person = next((d for d in detections if d.label == "person"), None)
        if person is None:
            return []
        px1, py1, px2, py2 = person.bbox
        h = py2 - py1
        upper_y = py1 + h // 3
        middle_y = py1 + (2 * h) // 3

        fired: list[Event] = []
        for action_name, obj_label, region in ACTION_RULES:
            if now - self.last_action_ts.get(action_name, 0.0) < ACTION_DEBOUNCE_S:
                continue
            obj = next((d for d in detections if d.label == obj_label), None)
            if obj is None:
                continue
            ocx, ocy = _bbox_center(obj.bbox)
            if not (px1 <= ocx <= px2):
                continue
            if region == "upper":
                in_region = py1 <= ocy <= upper_y
            elif region == "middle":
                in_region = upper_y <= ocy <= middle_y
            else:
                in_region = py1 <= ocy <= py2
            if not in_region:
                continue
            self.last_action_ts[action_name] = now
            fired.append(Event(now, "action_detected", action_name,
                              obj.track_id, obj.bbox, None, None))
        return fired

# ---------- Broadcast ------------------------------------------------------

def broadcast_event(event_id: int, ev: Event) -> None:
    try:
        httpx.post(
            f"{SERVER_BASE}/internal/event_added",
            json={
                "id": event_id,
                "ts": ev.ts,
                "event_type": ev.event_type,
                "object": ev.object,
                "track_id": ev.track_id,
                "thumb_path": ev.thumb_path,
                "location": ev.location,
                "room": ev.room,
            },
            timeout=0.5,
        )
    except Exception:
        pass

# ---------- Main loop ------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pi-ip", default="172.20.10.3", help="Pi stream IP")
    parser.add_argument("--port", type=int, default=9090, help="Pi stream port")
    parser.add_argument("--model", default="yolov8n.pt", help="YOLO model path")
    parser.add_argument("--show", action="store_true", help="Show live CV window")
    parser.add_argument("--room", default="Living Room",
                        help="Room label this camera is watching (e.g. 'Living Room', 'Kitchen'). "
                             "Every emitted event is tagged with this string — pick it per-camera.")
    args = parser.parse_args()

    stream_url = f"http://{args.pi_ip}:{args.port}"
    print(f"[rewind] loading {args.model}...")
    model = YOLO(args.model)

    print(f"[rewind] connecting to Pi stream at {stream_url}...")
    cap = cv2.VideoCapture(stream_url)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open stream at {stream_url}")

    conn = init_db()
    extractor = EventExtractor()
    frame_period = 1.0 / TARGET_FPS
    fps_counter = 0
    fps_timer = time.time()

    print("[rewind] running. Ctrl-C to quit.")
    try:
        while True:
            t0 = time.time()
            fps_counter += 1
            if t0 - fps_timer >= 3.0:
                actual_fps = fps_counter / (t0 - fps_timer)
                print(f"[fps] {actual_fps:.1f}")
                fps_counter = 0
                fps_timer = t0
            ok, frame = cap.read()
            if not ok:
                print("[rewind] stream read failed, reconnecting...")
                cap.release()
                time.sleep(1)
                cap = cv2.VideoCapture(stream_url)
                continue

            results = model.track(frame, persist=True, tracker=TRACKER_CFG, verbose=False, conf=0.20)[0]

            detections: list[TrackedDetection] = []
            surfaces: list[SurfaceDetection] = []
            if results.boxes is not None and results.boxes.id is not None:
                for box, tid in zip(results.boxes, results.boxes.id.int().tolist()):
                    cls = int(box.cls[0])
                    label = model.names[cls]
                    conf = float(box.conf[0])
                    x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                    if label in HERO_OBJECTS and conf >= HERO_OBJECTS[label]:
                        # Emit the raw COCO label — per CONTRACTS.md §1, label
                        # translation (remote→keys, bottle→pill bottle, etc.)
                        # happens at the query-context assembly seam in
                        # backend/query.py:DISPLAY_LABELS, NOT at ingestion.
                        # Keeps capture.py + capture_local.py vocabulary stable
                        # and lets the query layer control user-facing text.
                        detections.append(
                            TrackedDetection(tid, label, conf, (x1, y1, x2, y2))
                        )
                    if label in SURFACES:
                        pretty, floor = SURFACES[label]
                        if conf >= floor:
                            surfaces.append(
                                SurfaceDetection(label, pretty, (x1, y1, x2, y2))
                            )

            # Draw bounding boxes if --show
            if args.show:
                for d in detections:
                    x1, y1, x2, y2 = d.bbox
                    color = (0, 255, 0) if d.label != "person" else (255, 0, 0)
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    cv2.putText(frame, f"{d.label} #{d.track_id} {d.conf:.2f}",
                                (x1, y1 - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
                for s in surfaces:
                    x1, y1, x2, y2 = s.bbox
                    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 165, 255), 1)
                    cv2.putText(frame, s.pretty, (x1, y1 - 8),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 165, 255), 1)
                cv2.imshow("Rewind - Live", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            for ev in extractor.step(detections, surfaces):
                ev.room = args.room
                if ev.event_type != "person_left":
                    ev.thumb_path = save_thumb(frame, ev.ts)
                event_id = insert_event(conn, ev)
                tstr = datetime.fromtimestamp(ev.ts).strftime("%H:%M:%S")
                loc = f" @ {ev.location}" if ev.location else ""
                room = f" [{ev.room}]" if ev.room else ""
                print(f"[event {event_id}] {tstr} {ev.event_type:20s} "
                      f"{ev.object:20s} track={ev.track_id}{loc}{room}")
                broadcast_event(event_id, ev)

            dt = time.time() - t0
            if dt < frame_period:
                time.sleep(frame_period - dt)

    except KeyboardInterrupt:
        print("[rewind] shutting down.")
    finally:
        cap.release()
        if args.show:
            cv2.destroyAllWindows()
        conn.close()

if __name__ == "__main__":
    main()
