"""
Rewind — Proactive caregiver agent (starter)
Owner: Jossue (stretch — Saturday afternoon)

Wins the Eragon Mac Mini track:
- Reads event log (Rewind) + mock calendar + mock contacts
- Detects missed medication
- Drafts a tactful SMS to the caregiver via Claude
- Returns alerts for the dashboard to render
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta

from query import load_recent_events
from anthropic import Anthropic
import os
from dotenv import load_dotenv

load_dotenv()

MOCK_CALENDAR = [
    {"event": "Morning medication", "scheduled": "08:00", "window_min": 60},
    {"event": "Evening medication", "scheduled": "18:00", "window_min": 60},
]
MOCK_CONTACTS = [
    {"name": "Sarah (daughter)", "role": "caregiver", "phone": "+1-555-0199"},
]

@dataclass
class Alert:
    severity: str
    title: str
    body: str
    suggested_action: dict | None

def check_medication_adherence() -> list[Alert]:
    events = load_recent_events()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    alerts: list[Alert] = []

    # Evidence that medication was taken, strongest signal first:
    # 1. action_detected/taking_pills — the person+bottle-near-face rule in
    #    capture.py's ACTION_RULES. Strongest evidence: we saw the gesture.
    # 2. object_picked_up/bottle — weaker: pickup alone could be refilling,
    #    moving, cleaning. Included because the action rule can miss frames.
    #
    # Legacy "scissors" stand-in is gone as of the spatial-grounding rework
    # (HERO_OBJECTS narrowed; `bottle` now IS the pill-bottle stand-in).
    taken_times = []
    for ev in events:
        ev_date = datetime.fromtimestamp(ev.ts).strftime("%Y-%m-%d")
        if ev_date != today:
            continue
        if ev.event_type == "action_detected" and ev.object == "taking_pills":
            taken_times.append(datetime.fromtimestamp(ev.ts))
        elif ev.event_type == "object_picked_up" and ev.object == "bottle":
            taken_times.append(datetime.fromtimestamp(ev.ts))

    for dose in MOCK_CALENDAR:
        scheduled = datetime.strptime(f"{today} {dose['scheduled']}", "%Y-%m-%d %H:%M")
        window_end = scheduled + timedelta(minutes=dose["window_min"])
        was_taken = any(scheduled - timedelta(minutes=30) <= t <= window_end for t in taken_times)
        overdue = now - window_end

        if now < scheduled or was_taken:
            continue
        if overdue > timedelta(minutes=0):
            mins_overdue = int(overdue.total_seconds() // 60)
            alerts.append(Alert(
                severity="urgent" if overdue > timedelta(hours=2) else "warn",
                title=f"Missed: {dose['event']}",
                body=f"Scheduled for {dose['scheduled']}; {mins_overdue} min overdue.",
                suggested_action={
                    "type": "send_text",
                    "to": MOCK_CONTACTS[0]["phone"],
                    "to_name": MOCK_CONTACTS[0]["name"],
                    "draft": None,
                },
            ))
    return alerts

def draft_caregiver_text(alert: Alert) -> str:
    client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
    prompt = (
        f"Write a 2-sentence SMS to {MOCK_CONTACTS[0]['name']}, a family caregiver. "
        f"Tone: calm, factual, no alarm, warm. Do not catastrophize. "
        f"Subject: {alert.title}. Details: {alert.body}\n\n"
        f"Return only the SMS body, nothing else."
    )
    resp = client.messages.create(
        model="claude-opus-4-7",
        max_tokens=150,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(b.text for b in resp.content if b.type == "text").strip()

def run() -> list[dict]:
    alerts = check_medication_adherence()
    out = []
    for a in alerts:
        if a.suggested_action and a.suggested_action["type"] == "send_text":
            a.suggested_action["draft"] = draft_caregiver_text(a)
        out.append({
            "severity": a.severity,
            "title": a.title,
            "body": a.body,
            "suggested_action": a.suggested_action,
        })
    return out

if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
