---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kimi-code": minor
---

Support a permanent main-agent system prompt override via `~/.kimi-code/SYSTEM.md`: when present, it replaces the default system prompt for every session, with `${var}` context variables and `${base_prompt}` substituted at render time (v2 engine only: `KIMI_CODE_EXPERIMENTAL_FLAG=1 kimi -p`). Write `~/.kimi-code/SYSTEM.md` to override the main prompt.
