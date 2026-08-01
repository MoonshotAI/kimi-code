---
"@moonshot-ai/pi-tui": patch
---

Handle changes above the viewport without a destructive full redraw: clamp in-place edits to the visible window and re-anchor the viewport on above-window length changes, so scrollback is no longer cleared and the user's scroll position is preserved.
