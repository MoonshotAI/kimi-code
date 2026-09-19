---
"@moonshot-ai/kimi-code": minor
---

Stdio MCP servers can now start inside a remote environment via `environment_id` in `mcp.json`, with `envVars` controlling whether each forwarded variable is read from this machine (`local`) or resolved on the target (`remote`).
