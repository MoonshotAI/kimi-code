---
"@moonshot-ai/kimi-code": patch
---

Reconnect workspace MCP servers automatically with backoff when the initial connection fails or the connection drops, so their tools come back on their own; tune the interval with `[mcp] reconnect_initial_delay_ms` and `reconnect_max_delay_ms`.
