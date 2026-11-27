---
"@moonshot-ai/agent-core-v2": patch
---

For models without dynamic tool loading, keep the request tool list unchanged when an MCP server that already has tools in the session baseline adds tools mid-session; those tools are announced in a reminder only, as before. Tools from MCP servers with no tools in the baseline are still appended after the server connects.
