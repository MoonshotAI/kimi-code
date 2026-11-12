---
"@moonshot-ai/kimi-code": patch
---

Remove `/api/v2/mcp/*` and `POST /api/v1/mcp/servers/{id}:restart`, serving MCP server and OAuth management on `/api/v1/mcp/*` instead of the live-session `/api/v1/mcp/servers` list.
