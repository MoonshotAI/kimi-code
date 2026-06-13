---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Fix two agent-core edge cases: long MCP tool names now always get an 8-char hex hash suffix (a signed-hash bug could emit a 9-char `-xxxxxxxx` suffix), and an injected system reminder that gets folded into a compaction summary is now cleared instead of being pinned to the summary message — so plugin session-start blocks re-inject and plan-mode reminders stay at full strength after compaction.
