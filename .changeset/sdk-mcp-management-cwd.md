---
"@moonshot-ai/kimi-code-sdk": patch
---

Add an optional cwd parameter to the global MCP server management methods for project-layer-aware reads and guarded writes. On the v2 engine, MCP auth-status results are classified offline by default; pass verify: true to probe servers for implicit OAuth requirements.
