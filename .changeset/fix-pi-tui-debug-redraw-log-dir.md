---
"@moonshot-ai/pi-tui": patch
---

Make the TUI's debug logging robust on Windows: the `PI_DEBUG_REDRAW` and `PI_TUI_DEBUG` diagnostics no longer crash the render loop on a filesystem error, and `PI_TUI_DEBUG` writes render dumps to the OS temp dir instead of a hardcoded `/tmp`.
