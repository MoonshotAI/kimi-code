---
"@moonshot-ai/agent-core-v2": patch
---

Treat MCP server tools as deferred by default (opt out per server with `deferred: false` or globally with `[mcp] default_deferred = false`), add `[mcp] startup_wait_ms` / `KIMI_MCP_STARTUP_WAIT_MS` (default 2000ms, `0` skips waiting) to bound how long loop initialization waits for initial MCP discovery without cancelling pending connections, expose late-connected deferred tools inline for models without dynamic loading, and stop automatic background retries for initial stdio startup failures while keeping retries for remote startup failures and established connection drops.
