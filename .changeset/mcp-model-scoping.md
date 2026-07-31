---
"@moonshot-ai/kimi-code": minor
---

MCP server entries in mcp.json / config now accept an optional `models` list of exact model aliases or `prefix*` wildcards, and a server with `models` is loaded only for sessions whose model matches. Scoping is evaluated at session start — switching models mid-session does not reload MCP servers.
