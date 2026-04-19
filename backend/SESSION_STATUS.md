# Session Status — Resume Here

**Last updated:** 2026-04-19, pre-submission.
**Purpose:** paste this file (or its key sections) into a new Claude Code session when you return. Fresh Claude reads this → has full context → picks up exactly where we left off.

---

## TL;DR (30-second read)

- **Rewind** — ambient memory device for a physical space. HackPrinceton 2026 submission due Sunday 2026-04-19 8 AM. Team lead: Jossue.
- **Main is `d087098`** + [`621cd46` docs] (~30 commits across 12 merged PRs). Feature-complete. Smoke 6/6 (1 K2 flake with clean Claude failover). Demo-ready.
- **Deployment is Mode B** — Pi is a pure MJPEG sensor; Jossue's G14 is the compute hub (backend + YOLO + frontend). K2 Think V2 is primary LLM, Claude is failover, `_SAFE_FALLBACK` final.
- **Canonical reference**: [`docs/TECHNICAL_OVERVIEW.md`](../docs/TECHNICAL_OVERVIEW.md). Start there for the full architecture + schemas + phase log + prize alignments. [`docs/VIDEO_NARRATIVE.md`](../docs/VIDEO_NARRATIVE.md) for the pitch-video script.
- **Remaining critical path:** Devpost draft + submit, demo rehearsal walkthrough, produce the animated video.

---

## Right-now system state

| Layer | Where it runs | Status |
|---|---|---|
| Pi `stream_server.py` | Pi 4B at `172.20.10.4` on Jossue's iPhone hotspot | should be live; Pi camera LED on means it's capturing |
| `backend/` uvicorn | Jossue's G14 (WSL) on `:8000` | primary=k2, demo_mode=off unless user chose it |
| `pi/capture_local.py --pi-ip 172.20.10.4` | Jossue's G14 (second WSL tab) | 20–21 fps YOLO on RTX GPU |
| `frontend/` Next.js dev | Jossue's G14 on `:3000` | Ariji's UI + model selector (Auto/K2/Claude) |
| Phone-stand `/status` page | iPhone/iPad pointed at `http://<g14-lan-ip>:3000/status` | (not yet positioned for final demo) |

**.env on G14 has:** ANTHROPIC_API_KEY, K2_ENDPOINT, K2_API_KEY (real values). ElevenLabs NOT configured (graceful text-only). Twilio removed from code entirely.

---

## Resume-collaboration notes (durable rules — honor always)

- **Classify before acting.** Correctness bugs get fixed now; quality observations get queued to `prompt_debt.md` for Phase D. Don't mix categories.
- **Focused commits.** One concern per commit so `git bisect` stays surgical. Headers: `feat(backend):`, `docs(backend):`, `fix(backend):`, `refactor(backend):`, `test(backend):`. **No `Co-Authored-By: Claude` trailers** — Jossue wants human authorship only.
- **Data-layer fixes beat prompt-layer fixes** when both work. `DISPLAY_LABELS` + `humanize_timestamp` both live at the query-context seam, not in the prompt. The open Phase D item (confidence calibration on fallback-phrase) is the one prompt-layer exception.
- **Honest banners + honest contracts.** If code says X, CONTRACTS.md says X, banner says X. If one drifts, the code is wrong by definition.
- **Demo-shaped work > invisible work.** Prefer finishing a visible loop (something a teammate can watch working) over an invisible backend config change that only matters to my own verification.
- **Secrets never leave the user's possession.** Don't offer to receive API keys in chat. User handles all `scp backend/.env …` and non-Claude-channel key sharing.
- **Capture runbook commands as they crystallize.** Working deploy/restart patterns go into `RUNBOOK.md` immediately.
- **Asking-before-acting when ambiguous.** For destructive operations (force-push to main, delete shared branches, `git reset --hard` on shared state) — propose, get explicit yes. Auto mode doesn't override this.
- **Terse > verbose.** Bullet lists > paragraphs. Named tradeoffs > generic advice.

---

## Where things live (point next-session Claude here first)

| File | Role |
|---|---|
| [`docs/TECHNICAL_OVERVIEW.md`](../docs/TECHNICAL_OVERVIEW.md) | **Architecture reference.** Every component + schema + deployment recipe + phase log. Read first. |
| [`docs/VIDEO_NARRATIVE.md`](../docs/VIDEO_NARRATIVE.md) | Animated-video pitch script, tiger mascot narrative. |
| [`backend/PLAN.md`](./PLAN.md) | Original 8-phase roadmap (A–H). Phases A/B/C★/D (2 of 3) all landed. |
| [`backend/CONTRACTS.md`](./CONTRACTS.md) | Wire schemas (ingestion, WS, query, agent, state, env flags). |
| [`backend/prompt_debt.md`](./prompt_debt.md) | Phase D entries — 2 addressed (✅), 1 open (confidence calibration). |
| [`backend/test_scenarios.py`](./test_scenarios.py) | 6-scenario smoke test against mock events. Target 6/6 pass. |
| [`backend/observability.py`](./observability.py) | Rotating log + query-journal helpers. |
| [`backend/tts.py`](./tts.py) | ElevenLabs MP3 generation + serving. |
| [`backend/rewind.log`](./rewind.log) | `tail -f` this during demo — 3-level infra log. |
| [`backend/queries.jsonl`](./queries.jsonl) | Append-only product corpus of every `/query`. |
| [`RUNBOOK.md`](../RUNBOOK.md) | Deploy + verify + restart + nuke-and-reboot commands. |

---

## What's done — phase recap

| Phase | Status | Key artifacts |
|---|---|---|
| **A** — LLM resilience floor | ✅ closed | `/health`, honest banner, K2 placeholder guard, safe-fallback path |
| **B** — Integration contracts | ✅ closed | `CONTRACTS.md` v1, 10 fixtures, `test_scenarios.py` |
| **C ★** — Reliability harden | ✅ closed | structured logging (rewind.log), query journal (queries.jsonl), `REWIND_DEMO_MODE` flag |
| **D** — Reasoning quality | 2 of 3 | `DISPLAY_LABELS` + `humanize_timestamp` landed; confidence calibration (prompt-layer) still open |
| **Spatial grounding** (Sunghoo's PR #3) | ✅ integrated | `location` field, SURFACES dict, resolve_location heuristic, action_detected taxonomy |
| **Mode B laptop-offload** | ✅ deployed | Pi `stream_server.py` + G14 `capture_local.py` at 21 fps |
| **Ambient state channel** | ✅ wired | `/ws/state`, `/internal/state`, `broadcast_state` helper |
| **Eragon agent → alert broadcast** | ✅ wired | `/agent/check` lights up phone-stand via state channel; Twilio removed (draft-only by design) |
| **ElevenLabs TTS** | code ✅, keys ☐ | `tts.py` ready; add `ELEVENLABS_*` to `.env` to activate; graceful degrade when unset |
| **Model selector UI** | ✅ shipped | segmented Auto/K2/Claude in answer card, per-request override |
| **K2 resilience hardening** | ✅ | removed `response_format`, inline system prompt, brace-balanced JSON extraction, max_tokens=800, shouty prompt tail — 5/6 K2 direct answers |

## Remaining open items (low pri)

- **`REWIND_FIXTURE_MODE`** — reserved env flag, not implemented (inject `_mock_events` when DB empty/stale).
- **Anthropic exception classification** — 401/404 hard-fail vs 529/network transient-retry. "Not urgent" per PLAN.md.
- **`/query` rate limit** — 1 per 500 ms per client IP, polish tier.
- **Phase D confidence calibration** — prompt-layer entry in `prompt_debt.md`, defer to deliberate Phase D session.
- **SenseCAP firmware** — deferred per the 10 PM Friday cutoff in `sensecap/README.md`. Phone-stand `/status` is the shipping fallback.

---

## Git state on resume

```bash
git fetch --prune
git checkout main && git pull
git log --oneline origin/main | head   # sanity — tip should be 621cd46
```

Most recent commits (newest first):
```
621cd46 docs: add TECHNICAL_OVERVIEW.md + VIDEO_NARRATIVE.md (#12)
d087098 fix(frontend): pin Next.js to 14.2.5 (was 16.2.4) (#11)
f7dcde0 feat: per-request model selector (Auto / K2 / Claude) in UI (#10)
efd4a66 fix(backend): harden K2 Think V2 path against reasoning-model quirks (#9)
d4666a5 chore: drop committed .claude/settings.local.json + gitignore (#8)
8d5667f improved ui (#7)
24b57e9 important docs
556bc3a fix(backend): K2 model slug — MBZUAI-IFM/K2-Think-v2 (#6)
(earlier: Phase A–D, spatial grounding, state channel, Twilio removal, etc.)
```

**Branch hygiene:** `Jeeyan-Branch` still exists on remote — DO NOT merge, based on a stale pre-infrastructure state. Three merged PR branches (`cleanup/…`, `fix/k2-resilience`, `frontend`) also still on remote, safe to delete post-submission. `backend` branch is a stale working branch, safe to reset or leave.

---

## First message to paste into a fresh Claude session

Suggested opener:

> I'm resuming Rewind (HackPrinceton 2026). Read `backend/SESSION_STATUS.md` top to bottom first, then `docs/TECHNICAL_OVERVIEW.md` for any architectural questions. Main head is `621cd46`. Submission deadline Sunday 2026-04-19 8 AM. Current state: Mode B fully deployed, K2 primary answering well, ~30 commits landed, main feature-complete. Remaining critical path is Devpost draft + demo rehearsal + video production from `docs/VIDEO_NARRATIVE.md`. Honor the resume-collaboration notes in the status file — especially the secrets boundary and the "no Co-Authored-By: Claude" rule.

That's the warmest start. Fresh Claude lands fully briefed.
