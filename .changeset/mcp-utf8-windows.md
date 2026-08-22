---
"@moonshot-ai/mcp-client": patch
---

fix(mcp): force UTF-8 encoding for Python stdio servers on Windows

Set PYTHONIOENCODING=utf-8 for Python stdio MCP servers on Windows to prevent
encoding errors.
