# RUNBOOK — Rewind demo ops

Terse commands for hackathon-day operation. Not a tutorial; for 3 AM muscle memory.

Everything below assumes:
- Pi IPv4 on iPhone hotspot: **`172.20.10.4`** (also `rewindpi.local` from Windows/PowerShell; WSL can't resolve mDNS, use IPv4)
- User `pi` on Pi; backend root `~/rewind-backend/`; CV root `~/rewind-pi/`
- Shared SQLite via symlink: `~/rewind-backend/rewind.db → ~/rewind-pi/rewind.db` (likewise `thumbs/`)
- Pre-set SSH_ASKPASS trick assumed (WSL can't interactively prompt); or just `ssh pi@172.20.10.4` and type the password.

## 1 — Deploy changes

### Backend (runs on Pi)

```bash
# From WSL, after editing backend/*.py
rsync -av --exclude='.env' --exclude='.env.*' --exclude='.venv' \
      --exclude='__pycache__' --exclude='rewind.log' --exclude='queries.jsonl' \
      -e ssh /home/jossue/dev/hackprinceton/backend/ pi@172.20.10.4:~/rewind-backend/

# Restart on Pi
ssh pi@172.20.10.4 "pkill -f 'uvicorn server:app'; \
  cd ~/rewind-backend && source .venv/bin/activate && \
  nohup python -m uvicorn server:app --host 0.0.0.0 --port 8000 \
    > /tmp/backend.log 2>&1 < /dev/null & disown"
```

### CV pipeline (runs on Pi)

```bash
# Deploy
rsync -av --exclude='.venv' --exclude='__pycache__' --exclude='rewind.db' \
      --exclude='thumbs' -e ssh \
      /home/jossue/dev/hackprinceton/pi/ pi@172.20.10.4:~/rewind-pi/

# Run (foreground for demo, visible to you)
ssh pi@172.20.10.4
cd ~/rewind-pi && source .venv/bin/activate && python capture.py
# ^C to stop
```

### Frontend (runs on laptop)

```bash
cd frontend
# .env.local must point at the Pi over hotspot
echo "NEXT_PUBLIC_REWIND_API=http://172.20.10.4:8000" > .env.local
npm install   # only first time
npm run dev   # http://localhost:3000 in Windows browser
```

### Secrets

```bash
# Never through Claude. Always from your shell.
scp /home/jossue/dev/hackprinceton/backend/.env pi@172.20.10.4:~/rewind-backend/.env
# Then restart backend (above).
```

## 2 — Verify health

```bash
# Backend banner (shows DB path, Claude/K2 availability, primary LLM)
curl -s http://172.20.10.4:8000/health | python3 -m json.tool

# Events endpoint (what the frontend fetches)
curl -s http://172.20.10.4:8000/events | python3 -m json.tool | head -40

# Contract gate — this MUST return 403 from the laptop
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"id":1,"ts":0,"event_type":"person_entered","object":"person","track_id":1}' \
  http://172.20.10.4:8000/internal/event_added
# Expected: {"detail":"forbidden: /internal/* is localhost-only ..."}
```

Banner reads: `DB: ✓`, `Claude: ✓`, `K2: ✗` (until K2 key lands). `Primary LLM: claude` is the safe-floor.

## 3 — Tail logs

```bash
# Backend (uvicorn + startup banner + per-request INFO lines)
ssh pi@172.20.10.4 "tail -f /tmp/backend.log"

# Capture pipeline (print-on-event — silent between events is normal)
ssh pi@172.20.10.4 "cd ~/rewind-pi && tail -f nohup.out"   # if you nohup'd it

# SQLite (what the event log actually looks like)
ssh pi@172.20.10.4 "sqlite3 ~/rewind-pi/rewind.db \
  'SELECT id, datetime(ts,\"unixepoch\",\"localtime\"), event_type, object, track_id FROM events ORDER BY id DESC LIMIT 10;'"

# Next.js (in the terminal where you ran `npm run dev`)
# Watch for: "compiled successfully", CORS errors, 404s on /events
```

## 4 — Nuke and reboot (everything from scratch)

```bash
# 1. Kill everything on the Pi
ssh pi@172.20.10.4 "pkill -f 'uvicorn server:app'; pkill -f 'python capture.py'; pkill -f ws_sub.py"

# 2. (Optional) Wipe event log for a clean demo
ssh pi@172.20.10.4 "rm -f ~/rewind-pi/rewind.db; rm -rf ~/rewind-pi/thumbs"

# 3. Start backend
ssh pi@172.20.10.4 "cd ~/rewind-backend && source .venv/bin/activate && \
  nohup python -m uvicorn server:app --host 0.0.0.0 --port 8000 \
    > /tmp/backend.log 2>&1 < /dev/null & disown"

# 4. Start capture (interactive SSH session — easier to ^C)
ssh pi@172.20.10.4
cd ~/rewind-pi && source .venv/bin/activate && python capture.py

# 5. Start frontend (in WSL)
cd /home/jossue/dev/hackprinceton/frontend && npm run dev

# 6. Open http://localhost:3000 — timeline should populate as capture.py fires events
```

## Known gotchas

- **WSL can't resolve `rewindpi.local`.** Always use `172.20.10.4` from WSL. PowerShell/Windows can use either.
- **`/internal/*` is localhost-only by design.** If a POST returns 403, that's the middleware working, not a bug.
- **capture.py exits "immediately" after `running`** → usually means it received SIGINT from a stray signal. Run it in an interactive SSH session, not nested inside other shell commands.
- **iPhone hotspot DHCP** gives the Pi `172.20.10.4` by default. If the Pi reconnects and gets a different IP, update `.env.local` in frontend/ and restart `npm run dev`.
- **`.env` and `.env.local` never go through Claude.** User `scp`s them directly.
