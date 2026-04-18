# Session — 2026-04-18 · Pi hardware → live E2E wire

**Date:** 2026-04-18, early morning (T-minus ~12 h to Sunday 8 AM submission)
**Authors:** Jossue (driver) + Claude (pair)
**Branch:** `backend`

## Starting state

- Raspberry Pi was a brick. The 8 GB Gigastone microSD card wouldn't reliably complete a kernel boot.
- Nothing installed on the Pi beyond the SD card's stock OS attempts.
- `backend/` had never been deployed anywhere outside Jossue's laptop.
- `frontend/` had never talked to a real Pi backend — only mocks.

## What landed, end-to-end

### 1 — Pi hardware & base OS

- Ruled out the Gigastone microSD after it would rainbow-splash then blank. Rootfs corruption on cheap SD is the suspected story.
- **Pivoted to USB boot:** 229 GB SanDisk USB 3.0 drive in the Pi's blue USB 3.0 port. Pi 4B's default bootloader falls through to USB when SD is absent. Clean boot first try.
- OS landed as **Debian 13 (Trixie) Pi OS Lite 64-bit, Python 3.13.5, aarch64** — Imager's current default, *not* Bookworm/3.11 as the project README assumed.
- RAM variant: 4 GB. Swap: 2 GB.
- Network: **iPhone hotspot, Pi at `172.20.10.4`.** mDNS (`rewindpi.local`) resolves from Windows/PowerShell; WSL can't do mDNS, so from WSL always use the IPv4 literal. Public-venue WiFi remains a no-go: captive portal + client isolation will kill laptop↔Pi reachability.

### 2 — CV pipeline (`pi/`)

- `~/rewind-pi/.venv/` with all `pi/requirements.txt` deps.
- Installed **`torch 2.11.0+cpu` from `download.pytorch.org/whl/cpu`** *before* ultralytics, specifically to skip the ~3 GB of bundled NVIDIA CUDA wheels PyTorch now pulls by default on aarch64. This is non-obvious and worth locking in for anyone who re-flashes.
- `libgl1` + `libglib2.0-0` via apt — required by opencv-python's default (non-headless) wheel, missing from Lite.
- YOLOv8-nano weights cached locally on Pi.
- **Webcam:** Logitech Brio 101. Required unlocking the physical privacy shutter — initial frame was `min=10, max=15` (pure black) until the shutter was slid open.
- `capture.py` smoke-tested for 60 s:
  - 7 events emitted: 4 × `person_entered`, 2 × `object_placed` (bottle, remote), 1 × `person_left`.
  - 6 blurred 128×72 thumbnails saved. `person_left` correctly skips thumbs per spec.

### 3 — Backend on Pi (`~/rewind-backend/`)

- `rsync`'d from `backend/` **excluding `.env`** — secrets stay in Jossue's hands.
- Separate `.venv`; all `backend/requirements.txt` deps installed; `import server; app` loads with all 10 routes.
- Started via `nohup python -m uvicorn server:app --host 0.0.0.0 --port 8000 ... & disown`. Survives SSH drops, logs to `/tmp/backend.log`.
- **DB unification via symlink:** `~/rewind-backend/rewind.db → ~/rewind-pi/rewind.db`, likewise `thumbs/`. Zero code change; single SQLite; capture.py writes, backend reads.
- **Verified end-to-end:**
  - `/health` reachable from Pi-localhost **and** from WSL over hotspot WiFi (`http://172.20.10.4:8000/health`).
  - `/events` returns the 2 persisted events identically from both sources.
  - `/ws/events` accepts subscribers; synthetic POST to `/internal/event_added` triggers WS broadcast with matching payload.
  - `/internal/*` localhost gate enforced: external POST from `172.20.10.5` returns `403 "forbidden: /internal/* is localhost-only"`.
  - `CORSMiddleware(allow_origins=["*"])` already in `server.py:33` — Branch B surprise defused.

### 4 — Frontend wired against real Pi

- `frontend/.env.local` → `NEXT_PUBLIC_REWIND_API=http://172.20.10.4:8000` (gitignored).
- `npm install` clean (386 packages, Next 14.2.5, node 24).
- `npm run dev` running on WSL port 3000, ready in 1.9 s.
- First `GET /` → 200, 9.6 KB HTML, compiled in 1.3 s (484 modules).
- **Browser-side verification still pending** — see Gaps.

## Gaps identified

1. **Browser-side smoke test not yet observed.** Jossue has not opened `http://localhost:3000` in a Windows browser while I was watching. Can't claim Branch B is 100% proven until we see the timeline populate + WS-push a live event. Backend logs, `.env.local`, and dev server all sit waiting.
2. **LLM keys not yet on Pi** → `/query` returns `_SAFE_FALLBACK`. Intentionally deferred (this is Branch A). Unblock: `scp backend/.env pi@172.20.10.4:~/rewind-backend/.env` then restart uvicorn.
3. **`capture.py` same-frame timestamp dedup.** Multiple events emitted from one frame share identical `ts`. Matters for Phase D `humanize_timestamp()`. Owner: Sunghoo. Priority: low.
4. **`DB_PATH` not env-configurable** — `backend/server.py:55` uses relative `Path("rewind.db")`. The symlink workaround is fine; parameterizing via env var is a clean Phase C item whenever someone's already editing `server.py`.
5. **Phase C hardening untouched** per `backend/PLAN.md`: structured logging (`rewind.log`), query journal (`queries.jsonl`), `REWIND_DEMO_MODE` flag. Deferred until the demo loop is closed.
6. **No systemd for backend.** `nohup` survives SSH drops but not Pi reboots. Low priority unless venue power becomes an issue.
7. **SenseCAP firmware not started** (Ariji). The demo reveal at `[0:45–1:15]` per `docs/DEMO_SCRIPT.md` visibly depends on it. If blocked, phone-stand fallback keeps the demo viable.
8. **`capture.py` is currently not running** — left off so the Pi isn't burning camera/CPU on nothing. Must be restarted for rehearsal and for the demo. Command lives in `RUNBOOK.md §4`.

## Recommended next steps, ordered

1. **Close Branch B visibly.** Jossue opens `http://localhost:3000`, verifies DevTools shows `GET /events` + `WS /ws/events` green and timeline rendered.
2. **Prove live push.** Start `capture.py` on Pi (interactive SSH), put objects in front of camera, watch the browser timeline grow via WS push. This is the moment the demo wire becomes real.
3. **Branch A: LLM keys.** `scp backend/.env`, restart uvicorn, verify `/health` banner shows `Claude: ✓`, test `/query` with a canned question. Dashboard's answer card should now return real text.
4. **Rehearse the 2-minute demo** against the live stack. Time the reveal moment specifically (`[0:45–1:15]` from `DEMO_SCRIPT.md`); if end-to-end latency > 3 s, fall back to typed query.
5. **Unblock Ariji on SenseCAP** or commit to the phone-stand fallback. Decision point, not a work item.
6. **Phase C hardening** (PLAN.md: logging, journal, `DEMO_MODE`) after the demo loop is stable.
7. **Tune CV confidence floors in venue lighting** (Sunghoo, once on site).

## Artifacts left running

- **Pi (172.20.10.4):**
  - `~/rewind-pi/` — CV venv + capture.py (NOT running)
  - `~/rewind-backend/` — backend venv + uvicorn (RUNNING, nohup, `/tmp/backend.log`)
- **Laptop (WSL):**
  - `frontend/` — `npm run dev` RUNNING on `:3000`, PID tracked in shell.
- **Repo:**
  - `RUNBOOK.md` (new, root) — ops recipes.
  - `docs/SESSION_2026-04-18_pi_e2e.md` (this file).
  - `frontend/next-env.d.ts` + `frontend/package-lock.json` are newly present after `npm install`; **not committed** — left to whoever owns the frontend convention to decide whether they should be in version control.

## Ops one-liners (authoritative set in `RUNBOOK.md`)

```bash
# Backend restart on Pi
ssh pi@172.20.10.4 "pkill -f 'uvicorn server:app'; cd ~/rewind-backend && source .venv/bin/activate && nohup python -m uvicorn server:app --host 0.0.0.0 --port 8000 > /tmp/backend.log 2>&1 < /dev/null & disown"

# Backend health
curl -s http://172.20.10.4:8000/health | python3 -m json.tool

# Tail backend logs
ssh pi@172.20.10.4 "tail -f /tmp/backend.log"

# Event log
ssh pi@172.20.10.4 "sqlite3 ~/rewind-pi/rewind.db 'SELECT id, datetime(ts,\"unixepoch\",\"localtime\"), event_type, object FROM events ORDER BY id DESC LIMIT 20;'"
```
