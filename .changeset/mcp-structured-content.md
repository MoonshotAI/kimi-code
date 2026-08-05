---
"@moonshot-ai/kimi-code": patch
---

Avoid double-forwarding MCP `structuredContent` in tool results. Servers that follow the spec's fallback guidance already serialize the structured payload into a text content block; the `<mcp-structured-result>` block now detects such duplicates semantically (JSON parse + deep-equal, so serializer spacing and key order do not matter) and skips the `structuredContent` section instead of sending the same payload twice.
