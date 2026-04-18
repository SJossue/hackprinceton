"""
Offline unit tests for the CV pipeline (capture.py).
No camera or YOLO model required — tests the event extractor,
spatial grounding, action detection, DB layer, and thumbnail logic.

Run:  python -m pytest test_capture.py -v
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from capture import (
    DB_PATH,
    EventExtractor,
    SurfaceDetection,
    TrackedDetection,
    Event,
    _bbox_center,
    _iou,
    init_db,
    insert_event,
    resolve_location,
    save_thumb,
    broadcast_event,
    HERO_OBJECTS,
    SURFACES,
    ACTION_DEBOUNCE_S,
)


# ── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> sqlite3.Connection:
    """In-memory-style DB using a temp file so init_db() works normally."""
    monkeypatch.setattr("capture.DB_PATH", tmp_path / "test.db")
    return init_db()


@pytest.fixture
def extractor() -> EventExtractor:
    return EventExtractor()


def _det(tid: int, label: str, bbox: tuple[int, int, int, int], conf: float = 0.9) -> TrackedDetection:
    return TrackedDetection(track_id=tid, label=label, conf=conf, bbox=bbox)


def _surface(label: str, pretty: str, bbox: tuple[int, int, int, int]) -> SurfaceDetection:
    return SurfaceDetection(label=label, pretty=pretty, bbox=bbox)


# ── 1. Database ─────────────────────────────────────────────────────────────

class TestDatabase:
    def test_init_creates_table(self, db: sqlite3.Connection) -> None:
        tables = {r[0] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        assert "events" in tables

    def test_schema_has_location_column(self, db: sqlite3.Connection) -> None:
        cols = {r[1] for r in db.execute("PRAGMA table_info(events)")}
        assert "location" in cols

    def test_insert_and_retrieve(self, db: sqlite3.Connection) -> None:
        ev = Event(
            ts=1000.0, event_type="object_placed", object="bottle",
            track_id=1, bbox=(10, 20, 30, 40), thumb_path=None, location="the desk",
        )
        eid = insert_event(db, ev)
        assert eid >= 1
        row = db.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone()
        assert row is not None
        assert row[2] == "object_placed"  # event_type
        assert row[3] == "bottle"         # object
        assert row[7] == "the desk"       # location

    def test_idempotent_migration(self, db: sqlite3.Connection) -> None:
        """Calling init_db twice should not crash (ALTER TABLE guarded)."""
        init_db()  # second call


# ── 2. Bbox helpers ─────────────────────────────────────────────────────────

class TestBboxHelpers:
    def test_bbox_center(self) -> None:
        assert _bbox_center((0, 0, 100, 200)) == (50, 100)
        assert _bbox_center((10, 20, 30, 40)) == (20, 30)

    def test_iou_identical(self) -> None:
        assert _iou((0, 0, 10, 10), (0, 0, 10, 10)) == pytest.approx(1.0)

    def test_iou_no_overlap(self) -> None:
        assert _iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0

    def test_iou_partial(self) -> None:
        val = _iou((0, 0, 10, 10), (5, 5, 15, 15))
        assert 0.0 < val < 1.0
        # intersection = 5*5=25, union = 100+100-25=175
        assert val == pytest.approx(25 / 175)


# ── 3. Spatial grounding ────────────────────────────────────────────────────

class TestSpatialGrounding:
    def test_no_surfaces(self) -> None:
        assert resolve_location((10, 10, 50, 50), []) is None

    def test_bottom_center_containment(self) -> None:
        desk = _surface("dining table", "the desk", (0, 40, 200, 100))
        # Object sitting above the desk; bottom-center at y=50, inside desk bbox
        result = resolve_location((50, 20, 100, 50), [desk])
        assert result == "the desk"

    def test_containment_prefers_smaller_surface(self) -> None:
        big = _surface("dining table", "the desk", (0, 0, 500, 500))
        small = _surface("chair", "the chair", (40, 40, 120, 120))
        result = resolve_location((50, 50, 100, 100), [big, small])
        assert result == "the chair"

    def test_iou_fallback(self) -> None:
        # Object bottom-center NOT inside surface, but overlaps enough
        desk = _surface("dining table", "the desk", (0, 0, 60, 60))
        result = resolve_location((50, 50, 80, 80), [desk])
        # Bottom-center = (65, 80) — outside desk bbox, so falls to IoU rule
        assert result == "the desk"  # IoU > 0.05

    def test_no_match(self) -> None:
        desk = _surface("dining table", "the desk", (0, 0, 10, 10))
        result = resolve_location((200, 200, 300, 300), [desk])
        assert result is None


# ── 4. Event extractor: object placed / picked up ───────────────────────────

class TestObjectPlacedPickedUp:
    def test_object_placed_after_presence_frames(self, extractor: EventExtractor) -> None:
        det = _det(1, "bottle", (10, 10, 50, 50))
        events: list[Event] = []
        for _ in range(extractor.PRESENCE_FRAMES):
            events.extend(extractor.step([det]))
        placed = [e for e in events if e.event_type == "object_placed"]
        assert len(placed) == 1
        assert placed[0].object == "bottle"
        assert placed[0].track_id == 1

    def test_no_event_before_threshold(self, extractor: EventExtractor) -> None:
        det = _det(1, "bottle", (10, 10, 50, 50))
        for _ in range(extractor.PRESENCE_FRAMES - 1):
            events = extractor.step([det])
            placed = [e for e in events if e.event_type == "object_placed"]
            assert len(placed) == 0

    def test_object_picked_up_after_absence(self, extractor: EventExtractor) -> None:
        det = _det(1, "bottle", (10, 10, 50, 50))
        # Confirm placement
        for _ in range(extractor.PRESENCE_FRAMES):
            extractor.step([det])
        # Remove from view
        events: list[Event] = []
        for _ in range(extractor.ABSENCE_FRAMES):
            events.extend(extractor.step([]))
        picked = [e for e in events if e.event_type == "object_picked_up"]
        assert len(picked) == 1
        assert picked[0].object == "bottle"

    def test_no_pickup_before_absence_threshold(self, extractor: EventExtractor) -> None:
        det = _det(1, "bottle", (10, 10, 50, 50))
        for _ in range(extractor.PRESENCE_FRAMES):
            extractor.step([det])
        for _ in range(extractor.ABSENCE_FRAMES - 1):
            events = extractor.step([])
            assert not any(e.event_type == "object_picked_up" for e in events)

    def test_reappearance_resets_miss_counter(self, extractor: EventExtractor) -> None:
        det = _det(1, "bottle", (10, 10, 50, 50))
        for _ in range(extractor.PRESENCE_FRAMES):
            extractor.step([det])
        # Disappear for less than threshold
        for _ in range(extractor.ABSENCE_FRAMES - 2):
            extractor.step([])
        # Come back
        extractor.step([det])
        # Then disappear again — counter should restart
        events: list[Event] = []
        for _ in range(extractor.ABSENCE_FRAMES - 1):
            events.extend(extractor.step([]))
        assert not any(e.event_type == "object_picked_up" for e in events)


# ── 5. Event extractor: person entered / left ───────────────────────────────

class TestPersonEvents:
    def test_person_entered(self, extractor: EventExtractor) -> None:
        person = _det(10, "person", (100, 50, 250, 400))
        events: list[Event] = []
        for _ in range(extractor.PRESENCE_FRAMES):
            events.extend(extractor.step([person]))
        entered = [e for e in events if e.event_type == "person_entered"]
        assert len(entered) == 1
        assert entered[0].object == "person"

    def test_person_left(self, extractor: EventExtractor) -> None:
        person = _det(10, "person", (100, 50, 250, 400))
        for _ in range(extractor.PRESENCE_FRAMES):
            extractor.step([person])
        events: list[Event] = []
        for _ in range(extractor.ABSENCE_FRAMES):
            events.extend(extractor.step([]))
        left = [e for e in events if e.event_type == "person_left"]
        assert len(left) == 1

    def test_person_has_no_location(self, extractor: EventExtractor) -> None:
        """Persons should not get spatial grounding."""
        desk = _surface("dining table", "the desk", (0, 0, 500, 500))
        person = _det(10, "person", (100, 50, 250, 400))
        events: list[Event] = []
        for _ in range(extractor.PRESENCE_FRAMES):
            events.extend(extractor.step([person], [desk]))
        entered = [e for e in events if e.event_type == "person_entered"]
        assert entered[0].location is None


# ── 6. Event extractor: action detection ────────────────────────────────────

class TestActionDetection:
    def _setup_person_and_object(
        self, extractor: EventExtractor, obj_label: str, obj_bbox: tuple[int, int, int, int]
    ) -> list[Event]:
        person = _det(10, "person", (100, 0, 300, 300))
        obj = _det(20, obj_label, obj_bbox)
        dets = [person, obj]
        events: list[Event] = []
        for _ in range(extractor.PRESENCE_FRAMES):
            events.extend(extractor.step(dets))
        return events

    def test_taking_pills_upper_region(self, extractor: EventExtractor) -> None:
        # Bottle center in upper third of person bbox (y < 100)
        events = self._setup_person_and_object(extractor, "bottle", (150, 10, 200, 60))
        actions = [e for e in events if e.event_type == "action_detected"]
        assert any(a.object == "taking_pills" for a in actions)

    def test_using_phone_upper_region(self, extractor: EventExtractor) -> None:
        events = self._setup_person_and_object(extractor, "cell phone", (150, 10, 200, 60))
        actions = [e for e in events if e.event_type == "action_detected"]
        assert any(a.object == "using_phone" for a in actions)

    def test_reading_middle_region(self, extractor: EventExtractor) -> None:
        # Book center in middle third (y between 100 and 200 for person 0-300)
        events = self._setup_person_and_object(extractor, "book", (150, 110, 200, 180))
        actions = [e for e in events if e.event_type == "action_detected"]
        assert any(a.object == "reading" for a in actions)

    def test_no_action_outside_region(self, extractor: EventExtractor) -> None:
        # Bottle in the lower third (not "upper") — should NOT fire taking_pills
        events = self._setup_person_and_object(extractor, "bottle", (150, 220, 200, 280))
        actions = [e for e in events if e.event_type == "action_detected" and e.object == "taking_pills"]
        assert len(actions) == 0

    def test_no_action_outside_person_horizontal(self, extractor: EventExtractor) -> None:
        # Bottle outside person bbox horizontally
        person = _det(10, "person", (100, 0, 300, 300))
        bottle = _det(20, "bottle", (400, 10, 450, 60))  # way to the right
        events: list[Event] = []
        for _ in range(extractor.PRESENCE_FRAMES):
            events.extend(extractor.step([person, bottle]))
        actions = [e for e in events if e.event_type == "action_detected"]
        assert len(actions) == 0

    def test_action_debounce(self, extractor: EventExtractor) -> None:
        person = _det(10, "person", (100, 0, 300, 300))
        bottle = _det(20, "bottle", (150, 10, 200, 60))
        dets = [person, bottle]
        # First fire
        all_events: list[Event] = []
        for _ in range(extractor.PRESENCE_FRAMES + 5):
            all_events.extend(extractor.step(dets))
        pills_actions = [e for e in all_events if e.object == "taking_pills"]
        # Should fire exactly once (debounced)
        assert len(pills_actions) == 1

    def test_no_action_without_person(self, extractor: EventExtractor) -> None:
        bottle = _det(20, "bottle", (150, 10, 200, 60))
        events: list[Event] = []
        for _ in range(extractor.PRESENCE_FRAMES + 3):
            events.extend(extractor.step([bottle]))
        actions = [e for e in events if e.event_type == "action_detected"]
        assert len(actions) == 0


# ── 7. Spatial grounding through event extractor ────────────────────────────

class TestSpatialGroundingInExtractor:
    def test_placed_event_has_location(self, extractor: EventExtractor) -> None:
        desk = _surface("dining table", "the desk", (0, 40, 200, 100))
        bottle = _det(1, "bottle", (50, 20, 100, 50))
        events: list[Event] = []
        for _ in range(extractor.PRESENCE_FRAMES):
            events.extend(extractor.step([bottle], [desk]))
        placed = [e for e in events if e.event_type == "object_placed"]
        assert placed[0].location == "the desk"

    def test_picked_up_inherits_last_location(self, extractor: EventExtractor) -> None:
        desk = _surface("dining table", "the desk", (0, 40, 200, 100))
        bottle = _det(1, "bottle", (50, 20, 100, 50))
        for _ in range(extractor.PRESENCE_FRAMES):
            extractor.step([bottle], [desk])
        events: list[Event] = []
        for _ in range(extractor.ABSENCE_FRAMES):
            events.extend(extractor.step([], [desk]))
        picked = [e for e in events if e.event_type == "object_picked_up"]
        assert picked[0].location == "the desk"


# ── 8. Thumbnail generation ─────────────────────────────────────────────────

class TestThumbnail:
    def test_save_thumb_creates_file(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("capture.THUMB_DIR", tmp_path)
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        path = save_thumb(frame, 1234567890.123)
        assert Path(path).exists()
        assert path.endswith(".jpg")

    def test_thumb_is_small(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("capture.THUMB_DIR", tmp_path)
        frame = np.random.randint(0, 255, (480, 640, 3), dtype=np.uint8)
        path = save_thumb(frame, 9999.0)
        size = Path(path).stat().st_size
        # Blurred 128x72 JPEG should be tiny (< 10 KB)
        assert size < 10_000


# ── 9. Broadcast ────────────────────────────────────────────────────────────

class TestBroadcast:
    def test_broadcast_does_not_raise_on_failure(self) -> None:
        """broadcast_event swallows exceptions when server is offline."""
        ev = Event(
            ts=1000.0, event_type="object_placed", object="bottle",
            track_id=1, bbox=(10, 10, 50, 50), thumb_path=None,
        )
        # Should not raise even though no server is running
        broadcast_event(999, ev)

    def test_broadcast_sends_correct_payload(self) -> None:
        ev = Event(
            ts=1000.0, event_type="object_placed", object="bottle",
            track_id=1, bbox=(10, 10, 50, 50), thumb_path="thumbs/1000.jpg",
            location="the desk",
        )
        with patch("capture.httpx.post") as mock_post:
            broadcast_event(42, ev)
            mock_post.assert_called_once()
            payload = mock_post.call_args.kwargs["json"]
            assert payload["id"] == 42
            assert payload["event_type"] == "object_placed"
            assert payload["object"] == "bottle"
            assert payload["location"] == "the desk"


# ── 10. Multiple objects tracked simultaneously ─────────────────────────────

class TestMultiObject:
    def test_two_objects_independent_tracking(self, extractor: EventExtractor) -> None:
        bottle = _det(1, "bottle", (10, 10, 50, 50))
        phone = _det(2, "cell phone", (100, 100, 150, 150))
        events: list[Event] = []
        for _ in range(extractor.PRESENCE_FRAMES):
            events.extend(extractor.step([bottle, phone]))
        placed = [e for e in events if e.event_type == "object_placed"]
        assert len(placed) == 2
        labels = {e.object for e in placed}
        assert labels == {"bottle", "cell phone"}

    def test_one_picked_up_other_stays(self, extractor: EventExtractor) -> None:
        bottle = _det(1, "bottle", (10, 10, 50, 50))
        phone = _det(2, "cell phone", (100, 100, 150, 150))
        for _ in range(extractor.PRESENCE_FRAMES):
            extractor.step([bottle, phone])
        # Remove bottle, keep phone
        events: list[Event] = []
        for _ in range(extractor.ABSENCE_FRAMES):
            events.extend(extractor.step([phone]))
        picked = [e for e in events if e.event_type == "object_picked_up"]
        assert len(picked) == 1
        assert picked[0].object == "bottle"
        # No pickup for phone
        assert not any(e.event_type == "object_picked_up" and e.object == "cell phone" for e in events)


# ── 11. Config sanity ───────────────────────────────────────────────────────

class TestConfigSanity:
    def test_hero_objects_confidence_range(self) -> None:
        for label, conf in HERO_OBJECTS.items():
            assert 0.0 < conf < 1.0, f"{label} has invalid confidence floor {conf}"

    def test_surfaces_confidence_range(self) -> None:
        for label, (pretty, conf) in SURFACES.items():
            assert 0.0 < conf < 1.0, f"{label} has invalid confidence floor {conf}"
            assert isinstance(pretty, str) and len(pretty) > 0

    def test_all_event_types_covered(self) -> None:
        """Ensure the extractor can emit all documented event types."""
        expected = {"object_placed", "object_picked_up", "person_entered", "person_left", "action_detected"}
        # Run through a scenario that fires all event types
        ext = EventExtractor()
        person = _det(10, "person", (100, 0, 300, 300))
        bottle = _det(20, "bottle", (150, 10, 200, 60))
        all_events: list[Event] = []

        # Place person + bottle (fires person_entered, object_placed, action_detected)
        for _ in range(ext.PRESENCE_FRAMES):
            all_events.extend(ext.step([person, bottle]))

        # Remove both (fires person_left, object_picked_up)
        for _ in range(ext.ABSENCE_FRAMES):
            all_events.extend(ext.step([]))

        emitted_types = {e.event_type for e in all_events}
        assert expected == emitted_types, f"Missing: {expected - emitted_types}"
