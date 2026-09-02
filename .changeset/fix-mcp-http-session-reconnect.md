---
"@moonshot-ai/kimi-code": patch
---

Fix dropped streamable-HTTP MCP sessions never reconnecting on the legacy engine: tool calls now reconnect and retry transparently, and a failed server's tools stay registered and fail with the server's own error while it is down. `tool.list.updated` with reason `mcp.disconnected` now fires only when a server is removed or disabled, not on transient reconnects.
