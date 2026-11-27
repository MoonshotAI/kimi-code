---
"@moonshot-ai/kimi-code": patch
"kimi-code-app": patch
"kimi-code": patch
---

Keep the request tool list unchanged when MCP servers connect after startup or add tools mid-session, preserving prompt cache prefixes. On models without dynamic tool loading, these tools are only announced in a reminder; increase `[mcp] startup_wait_ms` or start a new session to call them directly.
