---
'@moonshot-ai/kimi-code': patch
---

MCP tool results now surface the spec-defined `structuredContent` field and `_meta` server metadata to the model as a serialized `<mcp-structured-result>` block, instead of silently dropping them. Servers that return their machine-readable contract in these fields work the same as on other MCP hosts.
