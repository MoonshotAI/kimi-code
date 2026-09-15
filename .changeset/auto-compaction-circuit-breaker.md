---
"@moonshot-ai/kimi-code": patch
---

Fix auto-compaction looping forever when the model's context window is small relative to the CLI's fixed request overhead (system prompt and tool schemas) — e.g. a self-hosted `openai_responses` model with a 32k `max_context_size`, where even an empty conversation trips the 0.85 trigger ratio. Auto-compaction now detects when repeated compactions fail to reduce the steady-state token count and disables itself for the rest of the session with a warning (suggesting a larger `max_context_size`, a lower `loop_control.reserved_context_size`, or a higher `loop_control.compaction_trigger_ratio`) instead of compacting on every step.
