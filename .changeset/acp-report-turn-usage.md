---
"@moonshot-ai/kimi-code": patch
---

Report token usage over ACP. The ACP adapter now populates `PromptResponse.usage` with cumulative session token counts (input, output, cache read/write, total) so ACP clients and orchestration platforms driving kimi over ACP can read per-turn cost. Reading usage is best-effort and never blocks or fails a completed turn.
