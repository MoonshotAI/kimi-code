---
"@moonshot-ai/kimi-code": patch
---

Fix chat requests failing with a 400 invalid tool schema error when a connected MCP server publishes a tool whose JSON Schema declares `type` next to `anyOf`/`oneOf`.
