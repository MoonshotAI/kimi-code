---
"@moonshot-ai/pi-tui": patch
---

Fix a crash when `PI_DEBUG_REDRAW=1` is set on a machine that has never written to `~/.pi/agent` before: the debug-redraw logger wrote to that directory without creating it first, so the first full redraw threw an uncaught `ENOENT` and silently killed the whole TUI. The logger now creates the directory before appending, and never lets a logging failure crash rendering.
