---
"@moonshot-ai/agent-core-v2": patch
---

Keep the session's top-level tool list frozen to the startup baseline for models without dynamic tool loading: MCP tools from servers that finish connecting after the startup wait and tools added mid-session are announced in reminders only instead of being appended to the request tool list, so prompt cache prefixes stay valid. Models without dynamic tool loading can no longer call those late-discovered tools in the current session; increase `[mcp] startup_wait_ms` (or `KIMI_MCP_STARTUP_WAIT_MS`) so slow servers join the baseline, or start a new session.
