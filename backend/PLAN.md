# Backend Execution Plan

**Owner:** Jossue · **Branch:** `backend` · **Living doc — update as phases complete.**

## Meta-principle

> The backend is never the reason the demo fails.

Everything below is organized around that one line. You own three things, in order of importance:

1. **The data contract.** Shapes Sunghoo produces and Jeeyan consumes pass through you. Locked schemas = integration is a merge. Ambiguous schemas = 6 hours of debugging. Frozen in [`CONTRACTS.md`](./CONTRACTS.md).
2. **The reasoning quality.** Given Sunghoo's events and Jeeyan's questions, the answer's correctness is your prompt + context assembly + failover logic. This is where Rewind feels like magic vs. a toy.
3. **The failure modes.** Every hackathon demo fails somewhere. The backend that degrades gracefully — timeouts, malformed events, missing keys, empty logs, unanswerable questions — is the one the judge doesn't notice anything wrong with.

Scope: `backend/server.py` (FastAPI) + `backend/query.py` (LLM layer) + `backend/agent.py` (Eragon) + [`CONTRACTS.md`](./CONTRACTS.md) (integration surface).

---

## Phase A — Foundation verified

**Goal:** confirm the pipeline works end-to-end in isolation, with your own eyes.

**Run:**

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example .env     # paste real ANTHROPIC_API_KEY
python test_scenarios.py    # expect 5/5 PASS
uvicorn server:app --reload --host 0.0.0.0 --port 8000
# browser: http://localhost:8000/health   → banner values as JSON
# browser: http://localhost:8000/docs     → Swagger, click through every endpoint
curl -X POST http://localhost:8000/query -H 'Content-Type: application/json' \
  -d '{"question":"where did I leave my keys"}'
curl -X POST http://localhost:8000/agent/check
```

**Exit criteria:** you have personally seen every endpoint respond correctly at least once, and you've **read every query answer aloud at demo pace**. LLM output that reads fine on screen often sounds terrible spoken — and the demo has TTS, so voice is what judges experience. Anything that feels robotic or clinical → drop it into [`prompt_debt.md`](./prompt_debt.md) verbatim (question + answer + what felt wrong). That file is the Phase D queue.

**Status:** in progress (your turn — test_scenarios.py needs your API key).

---

## Phase B — The contract, locked and documented

**Goal:** make integration with Sunghoo + Jeeyan a merge, not a negotiation.

**Outputs (landed):**

- [`CONTRACTS.md`](./CONTRACTS.md) — three wires (ingestion, broadcast, query API) fully spec'd. Localhost-only on `/internal/*`. `_model` enum includes `"fallback"`. Honest timeout characterization.
- [`examples/`](./examples) — 10 canonical JSON fixtures. Copy-paste into mock data, unit fixtures, curl payloads.
- Code aligned to contract: localhost middleware in `server.py`, `call_claude` sets its own `_model` so the fallback path is labeled truthfully.

**Exit criteria:** Sunghoo and Jeeyan can build without asking schema questions.

**Status:** complete.

---

## Phase C — Harden the reliability floor

**Goal:** survive conditions you can't control.

Not all items are equal — starred ones are demo-critical, the rest are polish.

- [x] **★ Localhost restriction on `/internal/*`** (done in Phase B alongside the contract).
- [x] **★ Hard per-call timeouts** on K2 (8 s) and Claude (10 s). Repair retry skipped on timeout.
- [x] **★ Safe fallback labeled `_model: "fallback"`** so the UI can show it honestly.
- [ ] **★ Structured logging with a three-level split that tells the failure layer at a glance.** Stdlib `logging` to `backend/rewind.log` (rotating). INFO = request received/answered, model used, latency. WARN = fallback triggered, K2 failover, slow request (>5 s), repair-retry used. ERROR = safe fallback actually served, malformed LLM output after repair, unrecoverable exception. `tail -f backend/rewind.log` on a second monitor at demo time is a legit production-feel moment — no need to mention it, just let judges notice. *(Infra telemetry.)*
- [ ] **★ Query journal — `backend/queries.jsonl`.** One JSON line per `/query` hit: `{"ts", "question", "answer", "model", "latency_ms", "confidence", "event_ids"}`. Separate file from the structured log with a separate schema — this is the *product* corpus, not infra telemetry. Mechanically a 15-min append-to-file change; payoff is outsized: (a) when Jeeyan says "the dashboard showed a weird answer 10 min ago," `grep` finds it without reproducing; (b) every prompt change in Phase D can be A/B-tested against the accumulated real-question corpus rather than hypotheticals; (c) "every query this weekend logged" is a truth-telling pitch flex when a judge asks how much the system has been exercised.
- [ ] **★ Two env flags, independent.** `REWIND_DEMO_MODE` → Claude-only, tightened timeouts, pre-warmed fallback answers (safety). `REWIND_FIXTURE_MODE` → inject `_mock_events()` transparently when SQLite is empty or >30 min stale (fake data). Split so at judging you can enable DEMO_MODE without FIXTURE_MODE if the camera's alive; flip FIXTURE_MODE additionally only when live events glitch. Two dials.
- [ ] **Classify Anthropic exceptions** as hard (401, 404) vs. transient (529 overloaded, connection reset). Hard → immediate fallback. Transient → one jittered retry at ~2 s, then fallback. Not urgent; noted for when you touch `call_claude` anyway.
- [ ] Rate limit on `/query`: 1 request per 500 ms per client IP. Excess returns a clean "still thinking" response instead of a double-answer during demo.
- [ ] Degradation ladder documented in one place — already covered in [`CONTRACTS.md` §4](./CONTRACTS.md#4-degradation-ladder-what-the-user-sees-when-things-go-wrong).

**Exit criteria:** you can pull the Ethernet, corrupt the DB, and kill the K2 endpoint — `/query` still returns a 200 with a sensible answer.

---

## Phase D — Reasoning quality

**Goal:** answers feel like magic, not like a chatbot. This is where the product actually wins.

- [ ] **Prompt engineering pass.** Start from [`prompt_debt.md`](./prompt_debt.md) — the failures Phase A collected become the test cases. Save current prompt as `prompts/v1.txt` before editing; write the new one as `prompts/v2.txt`; run both against the same 15 questions and diff. Levers to pull: persona framing, 2–3 few-shot Q-log-A examples, explicit anti-patterns forbidden ("do not begin with 'Based on'", "do not refer to 'the event log'"), pre-compute relative time in Python rather than asking the LLM to do it, tie `confidence` field to concrete criteria (`high` = directly stated in one recent event, `medium` = inferred from 2–3, `low` = ambiguous or guessing).
- [ ] **Context assembly.** Today `load_recent_events` sends the last 80 events. Add a `build_context(events, question)` that lightly classifies the question into `{find_object, recall_action, timeline, catch_all}` and filters appropriately (today-only for med questions, wider time window around the named object for find-my-X, etc.). One small classifier call before the main query — huge answer-quality win.
- [ ] **Temporal reasoning test suite** (`test_temporal.py`): "when did X last happen?", "how long has X been there?", "did X happen before or after Y?", "anything unusual in the last hour?" These are the multi-step cases K2 is designed for.
- [ ] **Answer formatting discipline.** Lock responses to 1–2 sentences. Long answers wreck demo pacing. If the model wants to say more, cut it. The answer card fits one paragraph; the SenseCAP fits 2 lines.

**Exit criteria:** 15 blind realistic questions, 13+ feel like "whoa, it gets me."

---

## Phase E — Eragon agent (Mac Mini prize)

**Goal:** turn the agent from "it generates text" into "it does real work."

The Eragon rubric: depth of action, context quality, workflow usefulness.

- [ ] **Multi-source context, visible in output.** Extend from just events → events + mock calendar + mock contacts + mock prior-SMS log. All local JSON files in `backend/mocks/`. Agent's output explicitly references which sources it consulted.
- [ ] **Action variety.** Add 3–4 action types beyond SMS: draft email to PCP summarizing the week, add calendar event "reschedule evening reminder earlier," bump a "days since missed dose" counter on the dashboard, compose a TTS reminder for next button-press.
- [ ] **Agent reasoning trace.** Add `reasoning_trace: string[]` to the response: `["checked event log → no meds since 8 AM", "checked calendar → evening dose 18:00", "checked contacts → Sarah primary", "checked prior SMS → tone: calm continuation", "drafted: [text]"]`. UI reveals on hover.
- [ ] **Rubric-fit summary** in the Devpost description: map explicitly to Eragon's 30/30/40 rubric.

**Exit criteria:** the agent response is visibly richer than "here's an SMS" and the rubric mapping is defendable to a judge.

---

## Phase F — K2 Think V2 integration (reMarkable prize)

**Goal:** K2 is a real part of the product, not a side API call (the MBZUAI rubric explicitly requires this framing).

- [ ] **K2 owns the hardest reasoning.** Default `/query` to Claude (stable). Route only temporal-reasoning questions (from `test_temporal.py`) to K2. Flag `_model: "k2-think-v2"` when K2 handled one.
- [ ] **K2-specific prompt.** Separate `prompts/k2_temporal.txt` optimized for K2's chain-of-thought style, distinct from the Claude system prompt. Makes "not a side API call" defensible.
- [ ] **Transparent failover with logging.** On K2 failure: fall through to Claude, log the failure + question in `k2_misses.jsonl` for post-hackathon analysis.

**Exit criteria:** K2 handles a specific, nameable class of questions in production-mode with a distinct prompt. You can point to a real demo answer K2 produced.

---

## Phase G — Observability + demo instrumentation

**Goal:** when the judge is standing there, everything they could ask is answerable from the UI.

- [ ] **`/status` upgrade** (builds on `/health`): DB present + last write + today's event count + all-time count; LLM status with last query latency; WS client count; last agent-run result; demo mode flag. Keep it as JSON; optional HTML view.
- [ ] **`/timeline` debug page.** HTML dump of last 200 events with times, types, thumbnail previews. For you + any judge who asks "can I see the raw events?"
- [ ] **Request log persistence.** Every `/query` gets appended to `queries.jsonl` (question, answer, model, latency, ts). Post-hackathon gold; during-hackathon debugging aid.
- [ ] **Pitch metrics.** Running counters: total events processed, total queries answered, average latency, % high-confidence. Surface on `/status` for quoting live during the pitch: "in the last 6 hours we've logged 312 events, answered 47 queries, avg latency 1.2 s."

**Exit criteria:** the backend tells its own story. A curious judge can inspect it.

---

## Phase H — Integration rehearsals

**Don't skip this. It's what teams that think they're ready discover they're not.**

| # | Rehearsal | What you're validating |
|---|---|---|
| 1 | You alone, mocks only | Clean run with zero ERROR-level logs |
| 2 | You + Sunghoo's Pi | Real events flow Pi → SQLite → `/events` → WS in under 2 s |
| 3 | Full stack (Pi + backend + Jeeyan's dashboard + SenseCAP) | 5 clean 2-minute demo runs; fix any flake between runs |
| 4 | Adversarial | Kill the Anthropic key → demo mode saves it. Unplug camera → stored events still answer. Restart server mid-query → client reconnects. Ask about nonexistent events → honest fallback. Rapid-fire questions → rate limiter catches it. |

**Exit criteria:** you've personally caused every failure mode you can think of and the demo still survives.

---

## Execution order

1. **Finish A** (you, now).
2. **B** complete.
3. **C** next — it's the last of the "must-haves" before the demo can be trusted.
4. **D** in parallel with C where possible (prompt work vs. logging work are independent).
5. **E, F, G** can parallelize on Saturday afternoon — each is self-contained.
6. **H** Saturday evening and Sunday pre-dawn.

When you hit something specific — a prompt that won't behave, a contract ambiguity, a failure mode I didn't anticipate — come back with specifics. This is the scaffold; craft is in the details.

---

## Progress log

<!-- Append one line per meaningful step. Most recent on top. -->

- **2026-04-18** — _Phase A dry run._ `test_scenarios.py` → 5/5 PASS against Claude. uvicorn startup banner + `/health` + `/docs` all responding. K2 truth-telling fix shipped (`_k2_configured()` rejects `"..."` placeholders; banner, /health, and query routing now agree). `.env.example` K2 lines emptied so next person copying gets correct behavior. CONTRACTS §4b gotcha added for K2 config semantics. 3 prompt-debt entries logged from reading answers aloud: (1) `confidence: high` on fallback-phrase — Path A calibrate now, Path B `answer_type` field later; (2) absolute time → relative — `humanize_timestamp()` at context-assembly layer; (3) stand-in labels surfacing (`scissors`/`remote`) — `DISPLAY_LABELS` dict at context-assembly seam, not prompt instruction. All three are data-layer fixes, not prompt fixes — important distinction for Phase D.
- **2026-04-18** — _Phase B tightening._ CONTRACTS.md now has §4b Gotchas (same-machine invariant, ts units, WS dedupe, fixtures-vs-timeline, etc.) and §4c Adding-a-new-event-type migration path. `prompt_debt.md` scaffold created as the Phase D queue. Phase C plan refined: log-level split (INFO/WARN/ERROR), two independent env flags (DEMO vs FIXTURE), Anthropic exception classification note.
- **2026-04-18** — _Phase B complete._ `CONTRACTS.md` with three wire schemas + degradation ladder + validation one-liners. 10 JSON fixtures in `examples/`. Code aligned: localhost middleware on `/internal/*` in `server.py`; `call_claude` owns its `_model` (so safe fallback is labeled `"fallback"` truthfully); per-call timeouts K2=8s, Claude=10s; repair retry skipped on hard errors.
- **2026-04-18** — _Roadmap restructured_ around the reliability-floor meta-principle (A–H phases).
- **2026-04-18** — _Phase B.0 (old plan):_ `query.py` hardened. `server.py` has `/health` + startup banner. `test_scenarios.py` ready. Commits: `d06cdbb` (plan), `11d5b1e` (query), `4a6083e` (health), `2c8caef` (tests), `8d29857` (progress log).
- **2026-04-18** — _Phase 0:_ plan written to `backend/PLAN.md`. Branch = `backend`.
