---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Add a global default MCP server connection timeout: set `[mcp] startup_timeout_ms` in `config.toml` or the `KIMI_MCP_STARTUP_TIMEOUT_MS` environment variable; a per-server `startupTimeoutMs` in `mcp.json` still takes precedence.
