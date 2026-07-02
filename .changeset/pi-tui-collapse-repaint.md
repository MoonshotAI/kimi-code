---
"@moonshot-ai/pi-tui": patch
---

Repaint the visible viewport in place when content collapses above it, and clamp deleted-line clearing to the screen bottom, so a large shrink with above-viewport changes no longer desyncs the cursor and blanks the screen.
