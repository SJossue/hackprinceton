# RUNBOOK — Rewind demo ops

Terse commands for hackathon-day operation. Not a tutorial; for 3 AM muscle memory.

**Two modes coexist** — pick one at boot time, don't mix:

- **Mode A — Pi-integrated** — everything runs on the Pi. Simplest; YOLO is CPU-bound on Pi 4 (~2 fps max).
- **Mode B — Laptop-offload** (recommended for demo) — Pi runs `stream_server.py` only, a laptop runs `capture_local.py` + backend + serves frontend. YOLO hits 20+ fps on laptop GPU. Ethernet between Pi and laptop keeps the MJPEG stream off any cellular hotspot.

Everything below assumes:
- **Pi network:** either iPhone hotspot IP (e.g. `172.20.10.7`) or Windows ICS'd ethernet subnet (typically `192.168.137.x`). Always confirm with `ping rewindpi.local` from **PowerShell** (WSL can't resolve mDNS). If the IP moved, update `frontend/.env.local` + this file.
- **User `pi` on Pi**; Mode A paths: `~/rewind-backend/`, `~/rewind-pi/`. Mode B on Pi only needs `~/rewind-pi/` with `stream_server.py`.
- **Mode A DB sharing:** symlink `~/rewind-backend/rewind.db → ~/rewind-pi/rewind.db` (likewise `thumbs/`). Mode B: DB + thumbs live on the laptop, no symlink needed.
- **Pre-set SSH_ASKPASS trick** assumed (WSL can't interactively prompt); or just `ssh pi@<ip>` and type the password.

## 1 — Deploy changes

### Backend (runs on Pi)

```bash
# From WSL, after editing backend/*.py
rsync -av --exclude='.env' --exclude='.env.*' --exclude='.venv' \
      --exclude='__pycache__' --exclude='rewind.log' --exclude='queries.jsonl' \
      -e ssh /home/jossue/dev/hackprinceton/backend/ pi@172.20.10.7:~/rewind-backend/

# Restart on Pi
ssh pi@172.20.10.7 "pkill -f 'uvicorn server:app'; \
  cd ~/rewind-backend && source .venv/bin/activate && \
  nohup python -m uvicorn server:app --host 0.0.0.0 --port 8000 \
    > /tmp/backend.log 2>&1 < /dev/null & disown"
```

### CV pipeline (runs on Pi)

```bash
# Deploy
rsync -av --exclude='.venv' --exclude='__pycache__' --exclude='rewind.db' \
      --exclude='thumbs' -e ssh \
      /home/jossue/dev/hackprinceton/pi/ pi@172.20.10.7:~/rewind-pi/

# Run (foreground for demo, visible to you)
ssh pi@172.20.10.7
cd ~/rewind-pi && source .venv/bin/activate && python capture.py
# ^C to stop
```

### Frontend (runs on laptop)

```bash
cd frontend
# .env.local points at whichever laptop runs backend:
#   Mode A: Pi's IP        NEXT_PUBLIC_REWIND_API=http://<pi-ip>:8000
#   Mode B: laptop's IP    NEXT_PUBLIC_REWIND_API=http://<hub-ip>:8000
# If phone/iPad on same LAN, use the laptop's LAN IP (not localhost).
echo "NEXT_PUBLIC_REWIND_API=http://<hub-ip>:8000" > frontend/.env.local
cd frontend && npm install   # only first time
npm run dev -- --hostname 0.0.0.0  # bind all interfaces so iPhone can reach
# Phone-stand browser: http://<laptop-lan-ip>:3000/status
```

### Mode B — start the whole stack

```bash
# On Pi (single SSH session, foreground):
ssh pi@<pi-ip>
cd ~/rewind-pi && source .venv/bin/activate && python stream_server.py
#  → MJPEG on port 9090. Ctrl-C to stop.

# On hub laptop (compute hub, can be Jossue's G14 or Sunghoo's Mac):
cd backend && source .venv/bin/activate
REWIND_DEMO_MODE=1 python -m uvicorn server:app --host 0.0.0.0 --port 8000
# In a second terminal, same laptop:
cd pi && source ../backend/.venv/bin/activate  # or any env with cv2+ultralytics
python capture_local.py --pi-ip <pi-ip>
# optional: --show to render live bounding-box preview
```

Boot order: Pi stream first, THEN capture_local. capture_local fails fast if the stream isn't reachable.

### Secrets

```bash
# Never through Claude. Always from your shell.
scp /home/jossue/dev/hackprinceton/backend/.env pi@172.20.10.7:~/rewind-backend/.env
# Then restart backend (above).
```

## 2 — Verify health

```bash
# Backend banner (shows DB path, Claude/K2 availability, primary LLM)
curl -s http://172.20.10.7:8000/health | python3 -m json.tool

# Events endpoint (what the frontend fetches)
curl -s http://172.20.10.7:8000/events | python3 -m json.tool | head -40

# Contract gate — this MUST return 403 from the laptop
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"id":1,"ts":0,"event_type":"person_entered","object":"person","track_id":1}' \
  http://172.20.10.7:8000/internal/event_added
# Expected: {"detail":"forbidden: /internal/* is localhost-only ..."}
```

Banner reads: `DB: ✓`, `Claude: ✓`, `K2: ✗` (until K2 key lands). `Primary LLM: claude` is the safe-floor.

## 3 — Tail logs

```bash
# Backend (uvicorn + startup banner + per-request INFO lines)
ssh pi@172.20.10.7 "tail -f /tmp/backend.log"

# Capture pipeline (print-on-event — silent between events is normal)
ssh pi@172.20.10.7 "cd ~/rewind-pi && tail -f nohup.out"   # if you nohup'd it

# SQLite (what the event log actually looks like)
ssh pi@172.20.10.7 "sqlite3 ~/rewind-pi/rewind.db \
  'SELECT id, datetime(ts,\"unixepoch\",\"localtime\"), event_type, object, track_id FROM events ORDER BY id DESC LIMIT 10;'"

# Next.js (in the terminal where you ran `npm run dev`)
# Watch for: "compiled successfully", CORS errors, 404s on /events
```

## 4 — Nuke and reboot (everything from scratch)

```bash
# 1. Kill everything on the Pi
ssh pi@172.20.10.7 "pkill -f 'uvicorn server:app'; pkill -f 'python capture.py'; pkill -f ws_sub.py"

# 2. (Optional) Wipe event log for a clean demo
ssh pi@172.20.10.7 "rm -f ~/rewind-pi/rewind.db; rm -rf ~/rewind-pi/thumbs"

# 3. Start backend
ssh pi@172.20.10.7 "cd ~/rewind-backend && source .venv/bin/activate && \
  nohup python -m uvicorn server:app --host 0.0.0.0 --port 8000 \
    > /tmp/backend.log 2>&1 < /dev/null & disown"

# 4. Start capture (interactive SSH session — easier to ^C)
ssh pi@172.20.10.7
cd ~/rewind-pi && source .venv/bin/activate && python capture.py

# 5. Start frontend (in WSL)
cd /home/jossue/dev/hackprinceton/frontend && npm run dev

# 6. Open http://localhost:3000 — timeline should populate as capture.py fires events
```

## Known gotchas

- **WSL can't resolve `rewindpi.local`.** Always use `172.20.10.7` from WSL. PowerShell/Windows can use either.
- **`/internal/*` is localhost-only by design.** If a POST returns 403, that's the middleware working, not a bug.
- **capture.py exits "immediately" after `running`** → usually means it received SIGINT from a stray signal. Run it in an interactive SSH session, not nested inside other shell commands.
- **iPhone hotspot DHCP** gives the Pi `172.20.10.7` by default. If the Pi reconnects and gets a different IP, update `.env.local` in frontend/ and restart `npm run dev`.
- **`.env` and `.env.local` never go through Claude.** User `scp`s them directly.
