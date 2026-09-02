---
"@moonshot-ai/kimi-code": patch
---

Add a per-server `deferred` field to MCP server configuration: when the model supports dynamic tool loading (experimental `tool-select` flag), set `deferred: false` to keep a server's tools in the top-level tool list instead of loading them on demand via `select_tools`.
