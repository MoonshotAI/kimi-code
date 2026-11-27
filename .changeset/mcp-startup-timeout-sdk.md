---
"@moonshot-ai/kimi-code-sdk": patch
---

Bundle deferred-by-default MCP tools, the configurable 2000ms initial MCP discovery wait budget (`[mcp] startup_wait_ms`) that keeps slow-starting stdio processes alive up to their 30000ms startup timeout, and manual-only recovery for failed initial stdio startups.
