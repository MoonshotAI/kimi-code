---
"@moonshot-ai/pi-tui": patch
---

Fix crashes on very narrow terminals: word-wrapping wide graphemes no longer recurses infinitely at one-column width, render width is clamped to a minimum of one column, and overwide rendered lines are truncated instead of throwing.
