---
"@moonshot-ai/kimi-code": minor
---

Add `cursor_copy_mode` for immediate, keyboard-only, or right-click selection copying, deprecating `copy_on_select`.

Fullscreen wheel scrolling now uses adaptive line counts by default instead of one line per wheel event. Set top-level `wheel_scroll_lines = 1` in `tui.toml` to restore fixed one-line scrolling, or hold `Alt` while scrolling to multiply the distance by five.
