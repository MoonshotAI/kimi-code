---
"@moonshot-ai/kimi-code": minor
---

Limit memory growth from finished subagents: only the 32 most recently completed or cancelled subagent scopes stay resident, and older ones are rebuilt on demand when resumed. Set KIMI_CODE_SUBAGENT_SCOPE_CACHE_SIZE to change the limit (0 disables eviction).
