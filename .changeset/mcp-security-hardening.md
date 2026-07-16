---
"@moonshot-ai/kimi-code": patch
---

Fix project-level mcp.json discovery and harden MCP server connections: enforce OAuth state validation, restrict stdio environment inheritance to an allowlist, block bearer-token leakage to internal addresses, and cap tool result size.
