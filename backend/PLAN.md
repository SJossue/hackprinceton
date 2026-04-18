# Backend Execution Plan

**Owner:** Jossue · **Branch:** `backend` · **Living doc — update as phases complete.**

Scope: FastAPI server (`server.py`) + LLM query engine (`query.py`) + Eragon proactive agent (`agent.py`). Integrates with Sunghoo's `pi/capture.py` (shared SQLite DB) and Jeeyan's `frontend/` (HTTP + WebSocket).

---

## Timeline reality check

Submission is **Sunday 2026-04-19, 8 AM**. Today is **Saturday 2026-04-18**. Roughly 24 hours remain. The Friday-2AM solo piece didn't happen — we swapped ownership Saturday morning, so Phases A and B are compressed into Saturday morning rather than spread Friday night.

```
 NOW (Sat AM)  ──▶  A: baseline     (30 min)
                    B: hardening    (2 hrs)
 Sat noon      ──▶  C: integration  (2 hrs — with Sunghoo + Jeeyan)
 Sat 1 PM      ──▶  ★ end-to-end checkpoint
 Sat 1–7 PM    ──▶  D: hero moments (Eragon + K2 + preset queries)
 Sat 7 PM–1 AM ──▶  E: polish + Devpost
 Sun 1–6 AM    ──▶  F: rehearse + sleep shifts
 Sun 6–8 AM    ──▶  G: submit
```

---

## Phase A — Baseline (you run locally)

**Goal:** prove the query path returns a valid JSON answer via Claude before touching anything else. Everything else depends on this.

**Tasks:**

1. `cd backend && python -m venv .venv && source .venv/bin/activate`
2. `pip install -r requirements.txt`
3. `cp ../.env.example .env` → paste real `ANTHROPIC_API_KEY`. Leave K2 vars blank for now.
4. `python query.py "where did I leave my keys"` → expect a JSON response with `_model: "claude-opus-4-7"` and a plausible answer against the mock events.
5. `uvicorn server:app --reload --host 0.0.0.0 --port 8000` → browse `http://localhost:8000/docs` → hit `/events`, `/query`, `/agent/check` from Swagger.

**Exit criteria:**

- [ ] `query.py` CLI returns parseable JSON
- [ ] `_model` field in response says `claude-opus-4-7` (confirms failover path works even with K2 unset)
- [ ] `GET /health` returns `{ "ok": true, ... }` (added in Phase B below)
- [ ] `POST /query` via Swagger returns same JSON shape
- [ ] `POST /agent/check` returns an array (may be empty if mock log doesn't trip adherence rules)

**If this phase fails:** stop. Either the API key is wrong, the model name moved, or the prompt isn't returning JSON. Fix at this layer — nothing downstream works otherwise.

---

## Phase B — Hardening (done in code by the agent — Jossue verifies)

**Goal:** make the query path robust enough to not demo-fail when an LLM adds prose around its JSON.

**Changes landing in this phase:**

- `query.py` — robust JSON extractor with one "repair" retry when the first response doesn't parse
- `query.py` — structured logs (`[k2]`/`[claude]` tags) so you can tell from stderr which model answered
- `query.py` — expanded `_mock_events()` with the three demo scenarios (morning meds taken, evening meds missed, hero-object placed)
- `server.py` — `GET /health` endpoint + startup banner
- `test_scenarios.py` — 5-question smoke harness

**Exit criteria:**

- [ ] `python test_scenarios.py` passes all 5 scenarios on Claude path
- [ ] Server startup banner shows `DB: ✓/✗`, `K2: ✓/✗`, `Claude: ✓/✗`
- [ ] `/health` returns the same info as JSON

**Commit strategy:** one focused commit per change (hardening, mock expansion, health endpoint, test harness) so diffs are reviewable.

---

## Phase C — Integration (Sat morning, with Sunghoo + Jeeyan)

**Goal:** real events from the Pi flow into the dashboard end-to-end.

### C1 — Wire to Sunghoo's capture.py

- Sunghoo runs `pi/capture.py` → writes to `rewind.db` → POSTs to `/internal/event_added`.
- Backend server picks it up, broadcasts on `/ws/events`.
- Verify: with both running, place an object in front of the webcam, see it land in the timeline.

**Integration contract (don't drift):**

```json
POST /internal/event_added
{
  "id": 42,
  "ts": 1713456789.12,
  "event_type": "object_placed",
  "object": "bottle",
  "track_id": 17,
  "thumb_path": "thumbs/1713456789120.jpg"
}
```

### C2 — Wire to Jeeyan's frontend

- Jeeyan sets `NEXT_PUBLIC_REWIND_API=http://<pi-ip>:8000` in `frontend/.env.local`.
- `GET /events?limit=80` populates timeline on load.
- `/ws/events` pushes live updates.
- `POST /query` round-trip works via the Ask button.
- CORS: already `allow_origins=["*"]` in `server.py:32`, good for demo.

### C3 — The Sat 1 PM checkpoint

From PROJECT.md: "judge places keys, presses Grove button, speaks into laptop, gets correct spoken answer + SenseCAP text."

Our piece of that: **spoken question → `/query` → JSON answer with times → correctly rendered by frontend.** If this works, backend is demo-ready.

**Exit criteria:**

- [ ] Real events from Pi appear in `rewind.db` AND in the dashboard timeline within 2 s
- [ ] `/query` answers against real events (not just mocks)
- [ ] Voice question → spoken answer loop works in ≤ 3 s (frontend measurement)

---

## Phase D — Hero moments (Sat 1–7 PM)

**Goal:** the three demo scenarios from `docs/DEMO_SCRIPT.md` produce crisp, confident answers.

1. **"Where did the judge put the object I handed them?"** — tests the live detection + recent-events reasoning.
2. **"Did I take my medication today?"** — `/query` should reference the pill-bottle + drinking events with specific times.
3. **Eragon proactive agent** — `/agent/check` returns an `urgent`-severity alert with a drafted SMS that sounds tactful, factual, non-alarmist.

### Eragon polish (the Mac Mini prize)

- Verify `agent.py` handles the "dose window passed with no pill-bottle pickup" case correctly.
- Draft quality: the SMS must sound like something a real adult daughter would send to check on her dad. Review 3 drafts and tune the prompt in `agent.py:80-86` if tone drifts.
- Stretch: add a second alert type — "no person detected in frame for 6+ hours today" — for the elderly-isolation pitch angle.

### K2 Think V2 path (the reMarkable prize)

- Get credentials from MBZUAI WhatsApp group.
- Drop them in `.env`: `K2_ENDPOINT=...` + `K2_API_KEY=...`.
- Test that `call_k2` gets used when keys are set; Claude still takes over on error.
- K2 is pitched as "primary for multi-step temporal reasoning" — the "when did someone last come in?" question is the one to showcase.

**Exit criteria:**

- [ ] All three demo scenarios produce consistent good answers across 5 consecutive runs
- [ ] Eragon draft SMS sounds like a human wrote it (review 3 samples)
- [ ] K2 path answers correctly when credentials are set; Claude failover still fires when K2 endpoint is hit with a bad payload

---

## Phase E — Polish + Devpost (Sat 7 PM — Sun 1 AM)

- Review all log messages — anything that says `print` that shouldn't be shown to a judge during debugging.
- Tune `SYSTEM_PROMPT` if answers are too long/short/formal.
- Rate-limit protection: if we get rate-limited during rehearsal (unlikely at ~5 queries/min), surface a clean error instead of a 500.
- **Devpost draft** — problem (1 para), solution (2 paras), tech stack (backend section: K2 primary, Claude failover, FastAPI on-Pi architecture, Eragon agent multi-source action). Academic grounding paragraph citing Bärmann & Waibel 2022.

---

## Phase F — Rehearse + sleep shifts (Sun 1–6 AM)

- Run the full 2-min demo 10× with stopwatch. Every run that exceeds 1:55 means something on the backend is slow — investigate.
- Pre-warm the Claude connection on server startup (one throwaway call) so the first real query isn't slower than the rest.
- **Sleep in shifts.** Backend shouldn't need tending between 2 and 6 AM if Phase D passed cleanly.

---

## Phase G — Submit (Sun 6–8 AM)

- 6 AM: final rehearsal. If anything feels flaky, cut it rather than fix it.
- 7 AM: Devpost submitted with GitHub link. Tracks: Healthcare (main), Hardware+AI, Eragon, K2 Think V2, Telora, Best Overall. Plus the Regeneron paragraph.
- 8 AM: hands off keyboard. Coffee. Rehearse verbal pitch 5× more before the 9:30 judging round.

---

## Risks + mitigations (backend-specific)

| Risk | Mitigation |
|---|---|
| Claude returns prose-wrapped JSON | Robust extractor + one repair retry (Phase B). Always falls back to a safe "I didn't see that happen." |
| K2 endpoint flakes mid-demo | Automatic silent failover to Claude. No user-visible change. |
| Anthropic rate limit during rehearsal | Budget queries during rehearsal; typical hackathon limits are fine for the demo (~1 query per 3 s). |
| SQLite locked while capture.py is writing | `check_same_thread=False` is already set. Reads are short. Not a real issue at 5 fps. |
| Model ID `claude-opus-4-7` wrong | Verified against environment-provided model list. Do NOT silently downgrade to 4.5/4.6. |
| Port 8000 in use on the Pi | Change with `--port 8001` in the uvicorn command, update `NEXT_PUBLIC_REWIND_API` + `SERVER_BASE` in `pi/capture.py`. Ping Sunghoo + Jeeyan if you change this. |
| Agent drafts a sketchy SMS that'd embarrass us in front of a judge | Review 3 drafts in Phase D. Tune prompt until tone is consistent. |

---

## Integration contracts (treat as immutable without a ping to the other owner)

### `/query` response (frontend depends on this exact shape)

```json
{
  "answer": "On the kitchen counter at 10:48 AM.",
  "confidence": "high",
  "event_ids": [3, 5],
  "_model": "claude-opus-4-7"
}
```

### `/agent/check` response

```json
[
  {
    "severity": "urgent",
    "title": "Missed: Evening medication",
    "body": "Scheduled for 18:00; 127 min overdue.",
    "suggested_action": {
      "type": "send_text",
      "to": "+1-555-0199",
      "to_name": "Sarah (daughter)",
      "draft": "Hi Sarah — Dad hasn't picked up..."
    }
  }
]
```

### `EventRow` (what Sunghoo writes, what both of us consume)

```ts
{ id, ts, event_type, object, track_id, thumb_path }
```

`event_type` ∈ `{object_placed, object_picked_up, person_entered, person_left, action_detected}`.

---

## Progress log

<!-- Append one line per meaningful step. Most recent on top. -->

- **2026-04-18** — _Phase B complete._ `query.py` hardened (JSON extractor verified against 7 fixture strings, Claude repair retry wired, safe fallback in place, mocks rewritten with relative offsets). `server.py` has `/health` + startup banner. `test_scenarios.py` ready for Jossue to run once deps are installed. Commits: `d06cdbb` (plan), `11d5b1e` (query), `4a6083e` (health), `2c8caef` (tests).
- **2026-04-18** — _Phase 0:_ plan written to `backend/PLAN.md`. Branch = `backend`. Tasks A–G outlined.
