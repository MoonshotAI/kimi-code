---
"@moonshot-ai/kimi-code": patch
---

Remove the `executor = "kaos"` option from MCP stdio server configuration. It was never implemented, and configs using it now fail validation at load time.
