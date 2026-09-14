---
"@moonshot-ai/pi-tui": patch
---

Stop clear-full-redrawing the whole transcript for in-place edits above the viewport, keep terminal scrollback intact on automatic full redraws, and rate-limit automatic clear-full-redraws to one per 2 seconds with a merged trailing redraw.
