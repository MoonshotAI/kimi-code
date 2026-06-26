---
"@moonshot-ai/agent-core": patch
---

fix(agent-core): force UTF-8 for Python MCP stdio servers on Windows

Default the child environment to `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`
so Python MCP servers use UTF-8 for stdout/stderr regardless of the active
Windows console codepage. Prevents `UnicodeEncodeError` when servers emit
characters such as U+2713 (✓).
