"""
Rewind — Pi-side capture + tracking + event extraction (starter)
Owner: Sunghoo

Run:   python capture.py
Deps:  opencv-python, ultralytics, numpy, httpx

Goal by 2 AM Friday: this runs on the Pi, captures @5fps, YOLOv8-nano + ByteTrack
gives persistent IDs, event extractor emits clean events into SQLite, and pings
the FastAPI server so the laptop dashboard sees them live.
No integration with other people's code tonight. Solo piece.
"""

from __future__ import annotations

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
SERVER_BASE = "http://127.0.0.1:8000"  # Jossue's FastAPI

# Hero objects: YOLO COCO labels we care about, with per-label confidence floor.
# Tune Saturday on exactly these objects in venue lighting.
HERO_OBJECTS = {
    "cell phone": 0.40,
    "bottle": 0.45,        # used as pill/supplement bottle (COCO has no pill class)
    "remote": 0.40,        # stand-in for keys (COCO doesn't have "keys")
    "book": 0.45,
    "person": 0.50,
}

# Surfaces used for spatial grounding. Detected each frame but DO NOT emit
# placed/picked events — they exist only to answer "where is this object?"
# when a hero event fires. Demo venue = college classroom.
#
# COCO has no "desk" class; "dining table" is the closest rectangular-top
# surface and works in practice (same stand-in pattern as HERO_OBJECTS).
# Add more surfaces (blackboard, whiteboard, etc.) later.
SURFACES = {
    "dining table": ("the desk",  0.35),
    "chair":        ("the chair", 0.35),
}

CAMERA_INDEX = 0
TARGET_FPS = 5
FRAME_W, FRAME_H = 640, 480
TRACKER_CFG = "bytetrack.yaml"   # ultralytics built-in

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
    location: str | None = None   # e.g. "the desk", resolved via SURFACES

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
        location TEXT
      )
    """)
    # Safe-migrate existing DBs that predate the `location` column.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(events)")}
    if "location" not in cols:
        conn.execute("ALTER TABLE events ADD COLUMN location TEXT")
    conn.commit()
    return conn

def insert_event(conn: sqlite3.Connection, ev: Event) -> int:
    cur = conn.execute(
        "INSERT INTO events (ts, event_type, object, track_id, bbox, thumb_path, location) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (ev.ts, ev.event_type, ev.object, ev.track_id,
         str(ev.bbox) if ev.bbox else None, ev.thumb_path, ev.location),
    )
    conn.commit()
    return cur.lastrowid

# ---------- Thumbnail (privacy-preserving) --------------------------------

def save_thumb(frame: np.ndarray, event_ts: float) -> str:
    # 128x72, heavy Gaussian blur, JPEG q=60 — no face ever legible
    small = cv2.resize(frame, (128, 72), interpolation=cv2.INTER_AREA)
    blurred = cv2.GaussianBlur(small, (9, 9), 0)
    path = THUMB_DIR / f"{int(event_ts*1000)}.jpg"
    cv2.imwrite(str(path), blurred, [cv2.IMWRITE_JPEG_QUALITY, 60])
    return str(path)

# ---------- Spatial grounding: "which surface is this object on?" --------

@dataclass
class SurfaceDetection:
    label: str                       # COCO label, e.g. "dining table"
    pretty: str                      # friendly name, e.g. "the desk"
    bbox: tuple[int, int, int, int]

def _bbox_center(b: tuple[int, int, int, int]) -> tuple[int, int]:
    x1, y1, x2, y2 = b
    return ((x1 + x2) // 2, (y1 + y2) // 2)

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

def resolve_location(
    obj_bbox: tuple[int, int, int, int],
    surfaces: list[SurfaceDetection],
) -> str | None:
    """
    Return the friendly name of the surface this object is "on".

    Heuristic, ranked:
      1. Object's bottom-center lies inside a surface bbox → that surface.
         (Matches the natural "resting on" geometry from a wall cam.)
      2. Else, surface with highest IoU against the object bbox (>0.05).
      3. Else, None.
    """
    if not surfaces:
        return None
    ox1, oy1, ox2, oy2 = obj_bbox
    obj_bottom = ((ox1 + ox2) // 2, oy2)

    # Rule 1: bottom-center containment (prefer smaller surfaces = more specific)
    containing = [
        s for s in surfaces
        if s.bbox[0] <= obj_bottom[0] <= s.bbox[2]
        and s.bbox[1] <= obj_bottom[1] <= s.bbox[3]
    ]
    if containing:
        containing.sort(key=lambda s: (s.bbox[2] - s.bbox[0]) * (s.bbox[3] - s.bbox[1]))
        return containing[0].pretty

    # Rule 2: best IoU
    best = max(surfaces, key=lambda s: _iou(obj_bbox, s.bbox))
    if _iou(obj_bbox, best.bbox) > 0.05:
        return best.pretty

    return None

# ---------- Event extractor: track-based state machine --------------------

# Action rules: each action is a (hero-object-label) held near a region of
# the person bbox. All are debounced independently. "region" is which third
# of the person bbox the action object's center must sit in.
#
#   upper  = head / mouth area (drinking, phone to ear, taking pills)
#   middle = torso / hands-in-lap (reading a book)
ACTION_RULES: tuple[tuple[str, str, str], ...] = (
    # (action_name,         object_label,  region)
    ("taking_pills",        "bottle",      "upper"),   # `bottle` is repurposed as pill bottle
    ("using_phone",         "cell phone",  "upper"),
    ("reading",             "book",        "middle"),
)

ACTION_DEBOUNCE_S = 8.0

class EventExtractor:
    """
    Track-id-aware extractor. Handles appearance, disappearance, spatial
    grounding against nearby surfaces, and a small set of person+object
    action rules (drinking, taking_pills, using_phone, reading).
    Simple, demo-safe, debuggable.
    """
    PRESENCE_FRAMES = 3     # ~0.6s @ 5fps
    ABSENCE_FRAMES = 10     # ~2s @ 5fps

    def __init__(self) -> None:
        # track_id -> label
        self.known_tracks: dict[int, str] = {}
        # track_id -> frames seen this round
        self.seen_count: dict[int, int] = {}
        # track_id -> frames missed since last seen
        self.miss_count: dict[int, int] = {}
        # track_id -> last known bbox
        self.last_bbox: dict[int, tuple[int,int,int,int]] = {}
        # track_id -> last resolved surface name (so pickup inherits location)
        self.last_location: dict[int, str | None] = {}
        # track_ids we've confirmed as "placed/entered"
        self.confirmed: set[int] = set()
        # per-action last-fire timestamp for independent debouncing
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

        # Update presence counters for seen tracks
        for tid, det in seen_ids.items():
            self.known_tracks[tid] = det.label
            self.seen_count[tid] = self.seen_count.get(tid, 0) + 1
            self.miss_count[tid] = 0
            self.last_bbox[tid] = det.bbox
            # Refresh spatial grounding every frame the object is visible so
            # the most recent "where is it" is available at pickup time.
            if det.label != "person":
                self.last_location[tid] = resolve_location(det.bbox, surfaces)
            if tid not in self.confirmed and self.seen_count[tid] >= self.PRESENCE_FRAMES:
                self.confirmed.add(tid)
                etype = "person_entered" if det.label == "person" else "object_placed"
                loc = None if det.label == "person" else self.last_location.get(tid)
                events.append(Event(now, etype, det.label, tid, det.bbox, None, loc))

        # Update miss counters for confirmed tracks that disappeared
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

        # Person-object action rules (drinking, pills, phone, reading)
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
            # Must be horizontally within the person bbox.
            if not (px1 <= ocx <= px2):
                continue
            # And vertically inside the target region.
            if region == "upper":
                in_region = py1 <= ocy <= upper_y
            elif region == "middle":
                in_region = upper_y <= ocy <= middle_y
            else:
                in_region = py1 <= ocy <= py2  # fallback: anywhere in person
            if not in_region:
                continue
            self.last_action_ts[action_name] = now
            fired.append(Event(now, "action_detected", action_name,
                              obj.track_id, obj.bbox, None, None))
        return fired

# ---------- Broadcast to FastAPI ------------------------------------------

def broadcast_event(event_id: int, ev: Event) -> None:
    """Non-blocking best-effort notify to FastAPI for WS broadcast."""
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
            },
            timeout=0.5,
        )
    except Exception:
        pass  # server may be offline during Phase 1 testing

# ---------- Main loop ------------------------------------------------------

def main() -> None:
    print("[rewind] loading YOLOv8-nano...")
    model = YOLO("yolov8n.pt")

    print(f"[rewind] opening camera index {CAMERA_INDEX}...")
    cap = cv2.VideoCapture(CAMERA_INDEX)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_W)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_H)
    if not cap.isOpened():
        raise RuntimeError("camera failed to open — check lsusb and v4l permissions")

    conn = init_db()
    extractor = EventExtractor()
    frame_period = 1.0 / TARGET_FPS

    print("[rewind] running. Ctrl-C to quit.")
    try:
        while True:
            t0 = time.time()
            ok, frame = cap.read()
            if not ok:
                continue

            # Track mode: persistent IDs across frames (ByteTrack)
            results = model.track(frame, persist=True, tracker=TRACKER_CFG, verbose=False)[0]

            detections: list[TrackedDetection] = []
            surfaces: list[SurfaceDetection] = []
            if results.boxes is not None and results.boxes.id is not None:
                for box, tid in zip(results.boxes, results.boxes.id.int().tolist()):
                    cls = int(box.cls[0])
                    label = model.names[cls]
                    conf = float(box.conf[0])
                    x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                    if label in HERO_OBJECTS and conf >= HERO_OBJECTS[label]:
                        detections.append(
                            TrackedDetection(tid, label, conf, (x1, y1, x2, y2))
                        )
                    # A label can be both a hero and a surface (e.g. "book"
                    # if we ever add it to SURFACES); keep surfaces separate.
                    if label in SURFACES:
                        pretty, floor = SURFACES[label]
                        if conf >= floor:
                            surfaces.append(
                                SurfaceDetection(label, pretty, (x1, y1, x2, y2))
                            )

            for ev in extractor.step(detections, surfaces):
                # Save thumbnail if we have bbox + the frame is "interesting"
                if ev.event_type != "person_left":
                    ev.thumb_path = save_thumb(frame, ev.ts)
                event_id = insert_event(conn, ev)
                tstr = datetime.fromtimestamp(ev.ts).strftime("%H:%M:%S")
                loc = f" @ {ev.location}" if ev.location else ""
                print(f"[event {event_id}] {tstr} {ev.event_type:20s} "
                      f"{ev.object:20s} track={ev.track_id}{loc}")
                broadcast_event(event_id, ev)

            dt = time.time() - t0
            if dt < frame_period:
                time.sleep(frame_period - dt)

    except KeyboardInterrupt:
        print("[rewind] shutting down.")
    finally:
        cap.release()
        conn.close()

if __name__ == "__main__":
    main()
