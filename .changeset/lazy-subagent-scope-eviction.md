---
"@moonshot-ai/kimi-code": patch
---

Limit memory growth from finished subagents: only the 32 most recently completed or cancelled subagent scopes stay resident, and older ones are rebuilt on demand when resumed.
