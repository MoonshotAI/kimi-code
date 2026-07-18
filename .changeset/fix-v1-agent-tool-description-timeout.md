---
"@moonshot-ai/kimi-code": patch
---

Correct the v1 engine `Agent` tool description to say "fixed 2-hour timeout" instead of the stale "fixed 30-minute timeout" — the default was raised to 2 hours in v0.23.6 (#1562) and aligned across engines in v0.24.2 (#1704), but the v1 tool description shown to the model was missed. Since the interactive CLI defaults to the v1 engine, this stale text is what most sessions injected into model context, which could cause the model to unnecessarily split long delegations or resume subagents believing they had been killed by a nonexistent 30-minute cap. Actual enforcement was already correct; only the LLM-facing description was wrong.
