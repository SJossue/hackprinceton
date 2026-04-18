# Session Status — Resume Here

**Last updated:** 2026-04-18, late Saturday, post-spatial-grounding integration.
**Purpose:** paste this file (or its key sections) into a new Claude Code session when you return. Fresh Claude reads this → has full context → picks up exactly where we left off.

---

## TL;DR (30-second read)

- **Who:** Jossue, team lead on HackPrinceton project **Rewind** (ambient memory node). Jossue owns `backend/` (FastAPI + LLM query + Eragon agent) + team-lead duties (Devpost, pitch, demo script). Sunghoo owns `pi/` CV pipeline. Jeeyan owns `frontend/`. Ariji owns `sensecap/` firmware + hardware.
- **Branch:** `backend`, based on `main`. Both on GitHub at `SJossue/hackprinceton`. **Do not commit to `main` directly** — merge from `backend` via PR #1 when rehearsal is green.
- **Head commit:** `1a1ad86` (origin/backend).
- **Open PR:** [#1 `backend → main`](https://github.com/SJossue/hackprinceton/pull/1), 24 commits. Held open until Sunday-morning rehearsal proves the stack.
- **Where in the plan:** Phase A + B + C ★ all closed. Phase D 2-of-3 data-layer fixes landed. **Spatial grounding integrated.** Remaining work is submission-day polish: rehearsal, SenseCAP check-in, merge, Devpost.
- **Submission deadline:** Sunday 2026-04-19 8 AM.
- **Meta-principle (non-negotiable):** the backend is never the reason the demo fails.

---

## Live system state

The stack is running right now on a Pi booted from a USB drive, with a fresh flash after the earlier partner's hotspot became unavailable.

| Piece | Where | State |
|---|---|---|
| Pi OS (Trixie / Py 3.13) | USB drive on Pi 4B (4GB) | Booted, SSH ready |
| Network | iPhone hotspot, Pi at **`172.20.10.7`** | Live. Note: iPhone DHCP shifts host on re-flash — always confirm via `ping rewindpi.local` from **PowerShell** (WSL doesn't do mDNS). |
| CV pipeline `~/rewind-pi/` | Pi | Installed (torch CPU, opencv, ultralytics 8.4.38, yolov8n weights cached). **`capture.py` NOT currently running** — must be started for live events. |
| Backend `~/rewind-backend/` | Pi | **Running** via nohup, logs `/tmp/backend.log`. `/health` shows Claude ✓, K2 ✗, DB with 9 events from earlier run. |
| DB unification | Symlink `~/rewind-backend/rewind.db → ~/rewind-pi/rewind.db` (same for `thumbs/`) | Live |
| `.env` (Claude key) | Pi `~/rewind-backend/.env` | Present. Jossue scp'd it. Secrets never pass through Claude. |
| Frontend dev server | Laptop WSL port 3000 | **Running** (`npm run dev`), pointed at `172.20.10.7:8000`. Browser was actively using the dashboard (POSTs to `/query` 200 OK observed in backend logs). |

## Critical next step before spatial grounding is visible

The 9 existing events in `rewind.db` are **pre-spatial** — they predate the `location` column. Backend has a defensive `NULL AS location` fallback so they don't crash `/events`, but they don't show grounding in answers either. To see *"on the desk"*:

```bash
ssh pi@172.20.10.7
cd ~/rewind-pi && source .venv/bin/activate && python capture.py
```

This triggers `init_db()` → `ALTER TABLE events ADD COLUMN location` → new events carry the field. Place a phone / pill bottle on a visible **desk (dining table)** or **chair** and new events will end with `@ the desk` in the capture terminal, and dashboard answers will read *"on the desk."*

---

## Resume-collaboration notes (durable, honor on every session)

- **Classify before acting.** Correctness bugs get fixed now; quality observations get queued for their phase. Don't mix categories.
- **Focused commits.** One concern per commit so `git bisect` stays surgical. Headers: `feat(backend):`, `docs(backend):`, `fix(backend):`, `refactor(backend):`, `test(backend):`. No `Co-Authored-By: Claude` in commit messages — user prefers human authorship.
- **Data-layer fixes beat prompt-layer fixes** when both work. Three Phase D items (stand-in labels, humanize time, confidence calibration) were all at the context-assembly seam. Two landed; confidence calibration is the remaining prompt-layer one.
- **Honest banners + honest contracts.** If the code says X, the contract says X, and the banner says X. If one drifts, the code is wrong by definition.
- **Demo-shaped work over invisible work.** When two tracks are independent, close the visible loop first (UI populates, team unblocked) over invisible infra. Surface integration risk early.
- **Secrets never leave the user's possession.** No accepting `.env` contents or API keys in chat. The user scp's — the sandbox will enforce this even against "proceed" instructions.
- **Capture runbook commands as they crystallize.** Working deploy/restart patterns go into `RUNBOOK.md` immediately, not later.
- **Asking-before-acting when ambiguous.** For publishing actions (push, PR, tweet, scp of secrets) — propose, get explicit yes.
- **Terse is better than verbose.** Bullet lists > paragraphs. Named tradeoffs > generic advice.

---

## Where things live (point next-session Claude here first)

| File | Role |
|---|---|
| [`backend/PLAN.md`](./PLAN.md) | **The roadmap.** 8 phases (A–H). Progress log at the bottom — most recent on top. Read this first. |
| [`backend/CONTRACTS.md`](./CONTRACTS.md) | **The wire schemas.** Three sections, plus §4 gotchas. Updated 2026-04-18 for the `location` field + new HERO_OBJECTS + new action_detected taxonomy. |
| [`backend/prompt_debt.md`](./prompt_debt.md) | **Phase D input queue.** Two of three entries marked `✅ addressed`; one (confidence calibration) still open, prompt-layer. |
| [`backend/examples/*.json`](./examples/) | 10 canonical JSON fixtures. May need a refresh for the `location` field — flagged as low-pri. |
| [`backend/test_scenarios.py`](./test_scenarios.py) | **Smoke test.** Now 6/6 — added "Where are my keys?" for spatial grounding, swapped stale drinking-cup scenario for "Did I take my pills?". |
| [`backend/rewind.log`](./rewind.log) | Phase C structured log. `tail -f` for infra telemetry at demo time. |
| [`backend/queries.jsonl`](./queries.jsonl) | Phase C query journal (product corpus). One JSON line per `/query`. |
| [`backend/observability.py`](./observability.py) | Logger + journal helpers. Singleton logger, fail-silent journal. |
| [`RUNBOOK.md`](../RUNBOOK.md) | Deploy / verify / tail-log / nuke recipes. Root of repo. IP-variable aware. |
| [`docs/SESSION_2026-04-18_pi_e2e.md`](../docs/SESSION_2026-04-18_pi_e2e.md) | Morning session log — full hardware pivot + deploy story. |

---

## What's done on the backend branch (recent → older)

```
1a1ad86 docs(contracts): add location field to event schema
c170977 feat(backend): DISPLAY_LABELS + mocks follow new HERO taxonomy
0527cb2 feat(backend): accept & thread location field through event path
237bc04 Add spatial grounding + broader action rules to Pi capture   ← Sunghoo's, cherry-picked
1612ef9 docs(runbook): new Pi IP + note on iPhone DHCP non-stickiness
0292651 feat(backend): humanize_timestamp at context-assembly seam
b38581c feat(backend): DISPLAY_LABELS translation at context-assembly seam
7fc752d feat(backend): query journal → queries.jsonl (Phase C ★)
688dd99 feat(backend): structured logging to rewind.log (Phase C ★)
e1f2c68 docs: add 2026-04-18 Pi→browser E2E session log
5f6c7f6 docs: add RUNBOOK.md for demo-day deploy/verify/restart recipes
(+ Phase A/B commits prior)
```

---

## Phase state

| Phase | Status | Notes |
|---|---|---|
| A (LLM resilience smoke) | ✅ closed | Claude-only path demo-viable |
| B (integration contracts) | ✅ closed | CONTRACTS.md v1; 10 fixtures |
| C (reliability floor) | ✅ starred items closed | structured logging, query journal, localhost gate, timeouts, safe fallback, K2 placeholder guard |
| C (remaining polish) | ☐ deferred by user | env flags (`REWIND_DEMO_MODE` / `REWIND_FIXTURE_MODE`), Anthropic exception classification (hard vs transient), `/query` rate limit |
| D (reasoning quality, data-layer) | ✅ 2 of 3 | `DISPLAY_LABELS` + `humanize_timestamp` landed; confidence calibration (entry #3) still open — prompt-layer, defer to deliberate Phase D session |
| Spatial grounding | ✅ integrated | Sunghoo's branch cherry-picked; backend + mocks + tests + contracts all updated |

---

## Teammate branch state

| Branch | Who | State | Action |
|---|---|---|---|
| `backend` | Jossue + me | PR #1 open, demo-viable | Merge after rehearsal |
| `Jeeyan-Branch` | Jeeyan | Stale — has ownership-flip baggage from `pi_sunghoo` base | Tell Jeeyan: close, rebranch from `main`, PR against `main` |
| `feature/spatial-grounding-actions` | Sunghoo | Cherry-picked into `backend` as `237bc04` | Close on GitHub with "superseded by #1" |
| `pi_sunghoo` | Sunghoo | Role-swap reversal — obsolete | Close with comment |
| (new Sunghoo branch) | Sunghoo | TBD — venue-lighting tuning for `SURFACES` confidence floors | Branch from `backend` tip |

---

## Immediate state (what's in your way right now)

Ordered by demo-criticality:

1. **Start `capture.py` on Pi** (physical — requires visible desk/chair, objects to place). Produces the first spatial-grounded events. Without this, `/events` timeline stays at 9 pre-spatial rows.
2. **Walk `docs/DEMO_SCRIPT.md`** with a stopwatch against the live stack. Log any rough answers to `prompt_debt.md` verbatim (don't fix inline).
3. **Decide SenseCAP fate** — Ariji check-in. Ship firmware or fall back to phone-stand.
4. **Merge PR #1** — only after #2 is green. `gh pr merge 1 --squash` or `--merge`; user's call on history style.
5. **Submit to Devpost** — team lead hat. Before Sunday 8 AM.

Polish items (do only if time):
- Jeeyan's fresh frontend PR — merge independently into `main`.
- Phase C env flags if you want the demo-day safety dials.
- Examples JSON refresh to include `location` field.

---

## Git state on resume

```bash
git fetch --prune
git checkout backend
git pull --rebase
git log --oneline main..backend | head      # sanity: tip should be 1a1ad86
cd backend && source .venv/bin/activate
python test_scenarios.py                    # should pass 6/6
```

Pi sanity:

```bash
curl -s http://172.20.10.7:8000/health | python3 -m json.tool
# Expect: ok=true, db.exists=true, llm.claude=true, k2=false, primary=claude
ssh pi@172.20.10.7 "tail -5 /tmp/backend.log"
```

If Pi is offline (hotspot off / power cycled / IP drifted):

```bash
# Confirm via PowerShell: ping rewindpi.local
# Update RUNBOOK.md + frontend/.env.local if IP moved.
# Restart backend via RUNBOOK §1 one-liner.
```

---

## First message to paste into a fresh Claude session

> I'm resuming backend work on Rewind. Read `backend/SESSION_STATUS.md` top to bottom before anything else. Current branch is `backend`, head `1a1ad86`. PR #1 is open against main with 24 commits; don't merge yet — waiting for rehearsal. Pi is at `172.20.10.7` on iPhone hotspot. Backend running on Pi, frontend dev server on laptop `:3000`, both pointed at Pi IP. Spatial grounding is integrated but hasn't fired yet because `capture.py` isn't running — starting it is step 1 in "Immediate state." Honor the resume-collaboration notes in the status file, especially the secrets boundary.
