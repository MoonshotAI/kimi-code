---
"@moonshot-ai/kimi-code": patch
---

Fix the token counts reported after compaction reading far below the real context size: the before/after stats and the context gauge now include the system prompt and tool definitions, matching the numbers shown while the session runs.
