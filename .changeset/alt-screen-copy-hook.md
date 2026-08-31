---
"@moonshot-ai/pi-tui": patch
---

Add `TuiAltScreenOptions.onCopy` so a host with a native clipboard binding receives text copied from an application-owned selection; the OSC 52 write stays as the fallback.
