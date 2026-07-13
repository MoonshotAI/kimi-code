---
"@moonshot-ai/agent-core": patch
---

Terminate the full MCP stdio process tree on client close.

On Windows, stdio MCP servers launched via `npx` leave behind a `node.exe`
server process when only the immediate `npx` child is killed. The close path
now escalates to a platform-specific process-tree kill (`taskkill /T` on
Windows, process-group signals on POSIX) so that both the wrapper and the
actual server are reaped.
