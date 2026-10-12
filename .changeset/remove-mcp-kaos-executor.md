---
"@moonshot-ai/kimi-code": patch
---

Remove the never-implemented `executor = "kaos"` option from MCP stdio server configuration; configs using it now fail validation at load time.
