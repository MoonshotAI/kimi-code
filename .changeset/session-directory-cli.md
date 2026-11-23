---
"@moonshot-ai/kimi-code": patch
---

`kimi -c` now continues only sessions that ran in the current directory; use `kimi -r <id>` for sessions of desktop projects. A `.kimi-code/mcp.json` in a repository subdirectory is no longer read; move it to the repository root.
