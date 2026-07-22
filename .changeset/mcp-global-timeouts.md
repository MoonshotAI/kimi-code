---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Add global default MCP server timeouts: `[mcp] startup_timeout_ms` / `[mcp] tool_timeout_ms` in `config.toml`, or the `KIMI_MCP_STARTUP_TIMEOUT_MS` / `KIMI_MCP_TOOL_TIMEOUT_MS` env vars.
