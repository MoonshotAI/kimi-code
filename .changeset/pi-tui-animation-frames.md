---
"@moonshot-ai/pi-tui": minor
---

Add browser-style animation frame requests to the TUI: every animation shares one frame clock that ticks at most every 120 ms, pauses when the TUI stops, and resumes when it starts.
