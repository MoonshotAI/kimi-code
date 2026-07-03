---
"@moonshot-ai/pi-tui": patch
---

Pin the viewport anchor on partial shrinks and repaint above-viewport shifts in place, so streaming shrink/grow cycles no longer stack duplicate copies of content in scrollback; only a collapse past the viewport top re-anchors the view.
