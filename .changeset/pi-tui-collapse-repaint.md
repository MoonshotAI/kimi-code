---
"@moonshot-ai/pi-tui": patch
---

Re-anchor the viewport with an in-place repaint whenever content shrinks below the screen bottom, and clamp deleted-line clearing to the screen bottom, so large shrinks no longer blank the screen, desync the cursor, or leave the UI hovering above dead rows.
