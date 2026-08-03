---
"@moonshot-ai/kimi-code": patch
---

Fix MCP tool results silently dropping `structuredContent`. Tools that declare an `outputSchema` return a machine-readable payload next to a human-oriented summary, and the model only received the summary (e.g. "returned 6 item(s)") with the actual data lost. The structured payload is now forwarded as JSON, unless the server already serialized it verbatim into a text content block.
