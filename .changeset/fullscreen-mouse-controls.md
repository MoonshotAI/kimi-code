---
"@moonshot-ai/kimi-code": minor
---

Add `cursor_copy_mode` for immediate, keyboard-only, or right-click selection copying, deprecating `copy_on_select`, and add `[mouse]` settings for fixed wheel line counts and Alt acceleration. Fullscreen wheel scrolling now uses adaptive line counts by default instead of the previous fixed one line per wheel event; set `wheel_scroll_lines = 1` under `[mouse]` in `tui.toml` to restore the previous behavior.
