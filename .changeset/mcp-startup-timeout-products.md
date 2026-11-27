---
"@moonshot-ai/kimi-code": patch
"kimi-code-app": patch
"kimi-code": patch
---

Load MCP tools on demand by default and cap the startup wait for MCP discovery at 2 seconds (`[mcp] startup_wait_ms`), letting slow-starting servers finish connecting in the background without blocking new sessions. Set `deferred: false` or `[mcp] default_deferred = false` to restore top-level inline tools, and reconnect failed initial stdio servers manually from `/mcp`.
