# Prompt Debt

Every time Rewind gives an answer that reads fine on screen but **sounds wrong spoken aloud** (robotic, clinical, hedging strangely, starts with "Based on the event log…"), drop the exact question and exact answer here.

This file is the Phase D queue. Prompt engineering in the abstract is endless; prompt engineering against real failures is surgical. By the time you sit down to rewrite `SYSTEM_PROMPT`, you want 5–10 concrete entries here so every edit has a target.

**Rule:** you're not debugging the answer, you're recording the failure. Don't fix here — fix in Phase D. Keep the entry short.

---

## Format per entry

```markdown
## [yyyy-mm-dd HH:MM · brief tag]
- **Question:** (verbatim)
- **Answer:**   (verbatim)
- **Model:**    claude-opus-4-7 | k2-think-v2 | fallback
- **What felt wrong:** one line — voice, hedge, tense, anti-pattern
- **Ideal-ish:** (optional — your first-pass rewrite)
- **Fix hypothesis:** where the fix belongs (prompt? context assembly? response schema?) and why
```

Use `date +'%Y-%m-%d %H:%M'` for copy-paste timestamps.

---

## Entries

<!-- newest on top -->

## 2026-04-18 02:43 · `confidence: high` on a fallback-phrase answer
- **Question:** Where is my laptop?
- **Answer:**   "I didn't see that happen."
- **Model:**    claude-opus-4-7 (not the safe-fallback path — this is Claude actively answering "don't know" with high confidence)
- **What felt wrong:** The model is technically correct to be "highly confident I don't have the answer," but a UI that styles responses by `confidence` will render this with the same visual weight as "your keys are on the counter." A known-unknown is structurally different from a known-known — it deserves different treatment, not just a different number.
- **Ideal-ish:** `{"answer": "I didn't see that happen.", "confidence": "low", "event_ids": []}` — or, better, add `answer_type: "not_observed"` and let the UI render on a muted neutral card.
- **Fix hypothesis:**
  - **Path A (hackathon scope, Phase D):** tie `confidence` to concrete criteria in the prompt — "high = directly stated in one recent event, medium = inferred from 2–3 events, low = cannot answer from log or requires guessing." Under this rubric, "I didn't see that" is automatically `low`. Re-uses existing UI styling hierarchy.
  - **Path B (Phase D+ stretch / Phase G integration):** extend response schema with `answer_type: "found" | "inferred" | "not_observed" | "ambiguous"`. UI styles by type, not just confidence. Structurally correct — represents that "don't know" is a different kind of answer, not just a less-confident one.

## 2026-04-18 02:43 · absolute time where relative reads warmer
- **Question:** When did the last person leave?
- **Answer:**   "The last person left at 02:42."
- **Model:**    claude-opus-4-7
- **What felt wrong:** Clock time is a computer answer. A human would say "just a minute ago" for something that happened ~60 seconds prior. Reading "zero-two-forty-two" aloud in TTS is especially robotic — and the demo has TTS, so voice is what judges hear.
- **Ideal-ish:** "Just a minute ago — they walked out of frame."
- **Fix hypothesis:** `humanize_timestamp(ts, now)` in **context assembly, before events reach the model** (not a prompt instruction). Contextual buckets:
  - within the last hour: "X minutes ago" / "a moment ago"
  - today: "earlier today around 10 AM"
  - prior day: "yesterday evening"
  - older: "3 days ago"
  Keep the absolute timestamp in the event alongside the relative one (`ts_relative` + `ts_absolute`) and let the model pick based on context — use absolute when specificity matters clinically (e.g., "8:02 AM" for medication timing), relative otherwise.

## ✅ 2026-04-18 02:43 · stand-in labels surfacing — *addressed*
- **Question:** What objects have been picked up today?
- **Answer:**   "Today I saw two items picked up: the scissors at 5:42 PM and the remote at 10:42 PM."
- **Model:**    claude-opus-4-7
- **What felt wrong:** Raw CV vocabulary (`scissors`, `remote`) leaks into the user-facing sentence. A roommate would say "your pill bottle" and "your keys," not the COCO labels we use as stand-ins because YOLO's vocabulary is missing those classes. This is not a prompt problem — it's a data-pipeline problem wearing a prompt problem's clothes.
- **Ideal-ish:** "Today you picked up your pill bottle around 5:42 PM and your keys around 10:42 PM."
- **Fix hypothesis:** **Translation layer in context assembly, not prompt instruction.** Add a `DISPLAY_LABELS: dict[str, str]` in `query.py` that rewrites the `object` field before events reach the LLM (`scissors → pill bottle`, `remote → keys`, `cup → water glass`). Deterministic, cheaper than prompting, invisible to the model. The CV layer's vocabulary is a technical reality; the user never needs to know about it. Translate at the seam between CV and language — do NOT rewrite labels at the ingestion layer (that would break the schema contract with `capture.py`), only at the query-context assembly layer.
- **Addressed:** `DISPLAY_LABELS` dict + `_display_label()` helper wired through `format_log()` in `query.py`. Verified end-to-end against the three mock events using `scissors`/`remote`: answers now say "pill bottle" and "keys" in both the context passed to the LLM and the user-facing `answer` string. `drinking_cup` (compound action token) left untranslated — different taxonomy, out of scope for this entry.
