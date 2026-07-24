---
"@moonshot-ai/kimi-code": patch
---

Fix remote MCP servers over HTTP/2 hanging during startup: the stream and requests now use HTTP/1.1 connections.
