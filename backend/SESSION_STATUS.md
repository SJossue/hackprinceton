# Session Status — Resume Here

**Last updated:** 2026-04-18, end of Phase A dry run.
**Purpose:** paste this file (or its key sections) into a new Claude Code session when you return. Fresh Claude reads this → has full context → picks up exactly where we left off.

---

## TL;DR (30-second read)

- **Who:** Jossue, team lead on HackPrinceton project **Rewind** (ambient memory node). After a role swap, Jossue owns `backend/` (FastAPI + LLM query + Eragon agent) + team-lead duties (Devpost, pitch). Ariji owns hardware + SenseCAP. Sunghoo owns Pi CV pipeline. Jeeyan owns frontend.
- **Branch:** `backend`, based on `main`. Both on GitHub at `SJossue/hackprinceton`. **Do not commit to `main` directly** — merge from `backend` when a chunk is demo-stable.
- **Head commit:** `579ea25` (origin/backend).
- **Where in the plan:** Phase B complete. **Phase A closing** (needs ~10 minutes of your hands-on verification). Phase C is next after Phase A closes.
- **Meta-principle (non-negotiable):** the backend is never the reason the demo fails.

---

## Resume-collaboration notes

These are the patterns we've settled into. Fresh-Claude should honor them:

- **Classify before acting.** Correctness bugs get fixed now; quality observations get queued for their phase. Don't mix categories.
- **Focused commits.** One concern per commit so `git bisect` stays surgical. Headers like `feat(backend):`, `docs(backend):`, `fix(backend):`, `refactor(backend):`, `test(backend):`. Never `Co-Authored-By: Claude` in commit messages — user prefers human authorship.
- **Data-layer fixes beat prompt-layer fixes** when both work. Three Phase D items (stand-in labels, humanize time, confidence calibration) are all at the context-assembly seam, not the prompt.
- **Honest banners + honest contracts.** If the code says X, the contract says X, and the banner says X. If one drifts, the code is wrong by definition — `CONTRACTS.md` v-marker bumps, not silent edits.
- **Asking-before-acting when ambiguous.** Auto mode is off. For anything that publishes (push, PR, tweet), propose + get explicit yes.
- **Terse is better than verbose.** Bullet lists > paragraphs. Named tradeoffs > generic advice. No "in summary" closers.

---

## Where things live (point next-session Claude here first)

| File | Role |
|---|---|
| [`backend/PLAN.md`](./PLAN.md) | **The roadmap.** 8 phases (A–H) organized around the reliability-floor meta-principle. Progress log at the bottom — most recent on top. Read this first. |
| [`backend/CONTRACTS.md`](./CONTRACTS.md) | **The wire schemas.** Three sections (ingestion, broadcast, query API), plus §4b Gotchas and §4c "how to add a new event_type." Authoritative — if code and contract drift, code is wrong. |
| [`backend/prompt_debt.md`](./prompt_debt.md) | **Phase D input queue.** Voice-test failures + fix hypotheses. Three entries logged from the Phase A dry run — all are data-layer fixes, not prompt-layer. |
| [`backend/examples/*.json`](./examples/) | **10 canonical JSON fixtures.** One per event_type + query request/response variants + agent alert variants. Used by both human reference and Jeeyan's MSW-style mocks. |
| [`backend/test_scenarios.py`](./test_scenarios.py) | **Smoke test.** 5 canned questions against `_mock_events()`. Target: 5/5 PASS. Only needs `ANTHROPIC_API_KEY`. |
| [`docs/PROJECT.md`](../docs/PROJECT.md) | The original 27 KB project bible — vision, architecture, full track strategy, demo script. Reference; don't rewrite. |

---

## Immediate state (what's in your way right now)

**Phase A is 80% closed.** Remaining hands-on items (you, ~10 min):

1. **Restart uvicorn** after the K2 fix (`47f581c`) so the banner re-renders:
   ```bash
   cd backend && source .venv/bin/activate
   uvicorn server:app --reload --host 0.0.0.0 --port 8000
   ```
   Expected: `K2: ✗ endpoint=(unset)`, `Primary LLM: claude`. Was previously lying.

2. **Re-run `python test_scenarios.py`** — should be 5/5 PASS and no `[k2] failed → falling back` noise per scenario.

3. **Hit `/query` at least 3 times** via `curl`, the Swagger at `/docs`, or the browser — **read every answer aloud at demo pace.** Anything that sounds robotic, clinical, or hedges weirdly → `prompt_debt.md` entry. The template already has three entries for reference.

4. **Hit `/agent/check` exactly once** and **paste the full output to your next Claude session.** The next Claude will apply a six-point SMS rubric:
   - Opening: hedge (human) vs. direct news-lead (clinical)
   - Length ≤3 sentences
   - No alarmist language ("concerning", "immediately", "critical")
   - Sign-off: none ≈ formal ≈ good; automated name = weird
   - Severity-vs-tone consistency (`urgent` that reads calm, or `warn` that reads panicky, both miscalibrated)
   - Prescribing vs. collaborating framing (affects Eragon rubric fit)
   Failures get logged to `prompt_debt.md` with `phase=E` tag (Eragon SMS craft), not `phase=D`.

5. **Write the Phase A close-out entry** in [`PLAN.md`](./PLAN.md) progress log. Narrative, not rubber-stamp — this is "future-you talking to Sunday-morning-you." Template suggested in the previous exchange:
   ```markdown
   ## Phase A — closed YYYY-MM-DD HH:MM

   Smoke test 5/5 green against real Anthropic. Banner fixed (K2
   placeholder guard shipped as 47f581c). Observations logged to
   prompt_debt.md: [3 D-phase items, any E-phase items from /agent/check].
   /query p50 latency: ~Xs. /agent/check produces [clean / slightly
   robotic / needs work] SMS drafts. Claude-only path is demo-viable.

   Gate complete. Cleared to Phase C.
   ```

Once those five land, you're cleared into **Phase C — harden the reliability floor**.

---

## Phase C preview (what's waiting)

From PLAN.md, in order of demo-criticality:

1. **Structured logging** — `backend/rewind.log`, rotating, stdlib. INFO/WARN/ERROR split so the failing layer is obvious at `tail -f`.
2. **Query journal** — `backend/queries.jsonl`, one line per `/query`. Separate file, separate schema, separate purpose (product corpus vs. infra telemetry). Both gitignored.
3. **Two env flags** — `REWIND_DEMO_MODE` (Claude-only, short timeouts, pre-warmed fallbacks) and `REWIND_FIXTURE_MODE` (inject mock events when SQLite is empty/stale). Independent dials so you can enable safety without forcing fake data at judging.
4. **Anthropic exception classification** — hard (401/404) → immediate fallback; transient (529/connection reset) → one jittered retry. Low-urgency but bundle with Phase C if you're already in `call_claude`.
5. **Rate limit on `/query`** — 1 per 500 ms per client IP; prevents double-answer during demo when a judge hammers Enter.

Estimated effort: 1.5–2 hours of focused work. All bullets are independent; can be cherry-picked if time pressure.

---

## Phase D preview (after Phase C)

Reasoning quality — "answers feel like magic, not chatbot." Driven by **real failures in `prompt_debt.md`**, not hypothetical prompt-engineering.

Already queued (from Phase A dry run):
- **Stand-in labels surfacing** (`scissors`, `remote` in user-facing text) → `DISPLAY_LABELS` dict at context-assembly layer. Data fix, not prompt fix.
- **Absolute time where relative reads warmer** → `humanize_timestamp(ts, now)` with contextual buckets. Data fix, not prompt fix.
- **`confidence: high` on fallback-phrase** → Path A: prompt rubric calibration. Path B (stretch): `answer_type` enum (`found | inferred | not_observed | ambiguous`) with distinct UI styling.

Plus whatever Phase A's manual `/query` round turns up.

Save current `SYSTEM_PROMPT` as `prompts/v1.txt` before any edit so you have a before/after to diff.

---

## Git state (for `git pull` + sanity check on resume)

```
* 579ea25 docs(backend): add query journal to Phase C (separate from structured log)
  6a0e95f docs(backend): Phase A observations — K2 gotcha + 3 prompt_debt entries
  47f581c fix(backend): K2 placeholder guard — banner + routing must not lie about primary
  aa5b680 docs(backend): tighten Phase B — gotchas, event-type migration, prompt_debt
  0e7da7e docs(backend): adopt full reliability-floor roadmap (Phases A-H)
  3cc26ea feat(backend): align code with contract — localhost gate + truthful _model
  dc0cfe9 docs(backend): lock integration contracts + 10 canonical JSON fixtures
  8d29857 docs(backend): log Phase B completion in PLAN.md
```

On resume:

```bash
git fetch --prune
git checkout backend
git pull --rebase
git log --oneline -5     # sanity
cd backend && source .venv/bin/activate
python -c "import query; print('imports OK; k2_configured:', query.k2_configured())"
```

Teammates' state (as of last check):
- `origin/main` — at `f9d8146` (swap commit). Your `backend` branch is ahead by 8 commits.
- `origin/Jeeyan's-Branch` — Jeeyan is working. Don't touch.
- Ariji: no branch yet; hardware work doesn't land in repo until the SenseCAP firmware piece begins.

---

## First message to paste into the fresh Claude session

Suggested opener:

> I'm resuming backend work on Rewind. Read `backend/SESSION_STATUS.md` top to bottom before anything else. I'm on the `backend` branch, head `579ea25`. I'm about to finish Phase A (5 items in the "Immediate state" section). When I come back with `/agent/check` output, apply the six-point SMS rubric and drop failures into `prompt_debt.md` with `phase=E` tag.

That's the warmest start. Fresh Claude will have everything it needs.
