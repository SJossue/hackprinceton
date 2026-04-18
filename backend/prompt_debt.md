# Prompt Debt

Every time Rewind gives an answer that reads fine on screen but **sounds wrong spoken aloud** (robotic, clinical, hedging strangely, starts with "Based on the event log…"), drop the exact question and exact answer here.

This file is the Phase D queue. Prompt engineering in the abstract is endless; prompt engineering against real failures is surgical. By the time you sit down to rewrite `SYSTEM_PROMPT`, you want 5–10 concrete entries here so every edit has a target.

**Rule:** you're not debugging the answer, you're recording the failure. Don't fix here — fix in Phase D. Keep the entry short.

---

## Format per entry

```markdown
## [yy-mm-dd HH:MM · brief tag]
- **Question:** (verbatim)
- **Answer:**   (verbatim, including any JSON wrapper weirdness)
- **Model:**    claude-opus-4-7 | k2-think-v2 | fallback
- **What felt wrong:** one line — voice, hedge, tense, anti-pattern
- **Ideal-ish:** (optional — your first-pass rewrite, one sentence)
```

Use `date +'%y-%m-%d %H:%M'` if you want copy-paste timestamps.

---

## Entries

<!-- newest on top -->

*(none yet — Phase A will fill these in)*
