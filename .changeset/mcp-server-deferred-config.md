---
"@moonshot-ai/kimi-code": patch
---

Add a per-server `deferred` field to MCP server configuration: when the model supports dynamic tool loading (experimental `tool-select` flag), set `deferred: true` to keep a server's tools out of the top-level tool list and load them on demand via `select_tools`; servers are exposed inline by default.
