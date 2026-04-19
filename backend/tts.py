"""
Rewind — ElevenLabs TTS for ambient-display voice output.
Owner: Jossue

The ambient display (phone-stand / future SenseCAP) should *speak* answers
and alerts in a warm human voice, not stay silent or rely on robotic
browser TTS. This module wraps the ElevenLabs REST API, writes MP3 to
a local directory served by FastAPI's StaticFiles, and returns a URL
path the ``/status`` page can drop straight into ``<audio autoplay>``.

Design:

- Fail-safe like every other optional subsystem (Twilio, K2): if
  ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID are unset, ``speak()`` returns
  ``None`` and callers just skip the audio_url in their broadcast. Text
  path stays live.
- Lowest-latency model (``eleven_flash_v2_5``) so the demo reveal doesn't
  drag. First byte in ~200 ms; full MP3 for a 1-sentence answer in
  ~400–800 ms. Adds ~300–600 ms to /query end-to-end.
- MP3s land in ``backend/audio/{ts_ms}.mp3``. Gitignored. No cleanup —
  at free-tier volume (10K chars/month) the directory stays tiny for
  a weekend demo.
- Never raises. Any exception (rate limit, 401, network) → logged WARN,
  returns ``None``. A dead TTS is a minor demo downgrade, not a crash.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

from observability import get_logger

load_dotenv()

_LOG = get_logger()

ELEVENLABS_API_KEY  = os.getenv("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "").strip()

# Directory where generated MP3s live. Served at /audio/* by server.py.
AUDIO_DIR = Path("audio")
AUDIO_DIR.mkdir(exist_ok=True)

# Low-latency model for demo-moment responsiveness.
MODEL_ID = "eleven_flash_v2_5"
# Per-call timeout; TTS is a fast path, bail quickly if it's misbehaving.
TTS_TIMEOUT_S = 6.0


def tts_configured() -> bool:
    return bool(ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID)


def speak(text: str) -> str | None:
    """Generate an MP3 for ``text`` and return the URL path (e.g.
    ``/audio/1776554400123.mp3``). Returns ``None`` on any failure —
    callers should treat None as "no audio, proceed text-only."
    """
    if not tts_configured():
        return None
    if not text or not text.strip():
        return None

    # Defensive truncation — very long answers make TTS slow and expensive.
    # The demo answer budget is already ~2 sentences per SYSTEM_PROMPT.
    text = text.strip()[:600]

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "accept":     "audio/mpeg",
        "content-type": "application/json",
    }
    body = {
        "text": text,
        "model_id": MODEL_ID,
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
            "style": 0.0,
            "use_speaker_boost": True,
        },
    }

    try:
        r = httpx.post(url, json=body, headers=headers, timeout=TTS_TIMEOUT_S)
        r.raise_for_status()
        audio_bytes = r.content
    except Exception as exc:
        _LOG.warning("tts.speak: elevenlabs call failed — text delivery continues: %s", exc)
        return None

    ts_ms = int(time.time() * 1000)
    out_path = AUDIO_DIR / f"{ts_ms}.mp3"
    try:
        out_path.write_bytes(audio_bytes)
    except Exception as exc:
        _LOG.warning("tts.speak: could not write audio file: %s", exc)
        return None

    _LOG.info("tts.speak: wrote %s (%d bytes) for text=%r",
              out_path.name, len(audio_bytes), text[:60])
    return f"/audio/{out_path.name}"
