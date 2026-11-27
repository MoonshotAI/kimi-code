---
"@moonshot-ai/kimi-code": patch
"kimi-code-app": patch
"kimi-code": patch
---

Allow project MCP config files to disable a same-named user server with `{ "enabled": false }` without repeating its connection settings, avoid starting lower-priority MCP servers that are shadowed by a higher-priority source, and share MCP connections across sessions in the same project until the last session releases them.
