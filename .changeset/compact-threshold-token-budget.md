---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Add `/compact-threshold-k [<thousands>|off]` slash command: set a session-scoped absolute compaction trigger in thousands of tokens (e.g. `/compact-threshold-k 120` triggers at 120 000 tokens, regardless of the active model's context size). Mirrors the existing `/compact-threshold` (ratio) command but takes an absolute token cap. The SDK exposes `Session.setCompactionTokenBudget(tokens?)` and the session status payload now includes `compactionTokenBudget` / `compactionTokenBudgetOverridden`.
