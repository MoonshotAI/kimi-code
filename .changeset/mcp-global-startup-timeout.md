---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Add global default MCP server timeouts: set `[mcp] startup_timeout_ms` (connection) or `[mcp] tool_timeout_ms` (single tool call) in `config.toml`, or the `KIMI_MCP_STARTUP_TIMEOUT_MS` / `KIMI_MCP_TOOL_TIMEOUT_MS` environment variables; per-server fields in `mcp.json` still take precedence.
