---
"@moonshot-ai/kimi-code": minor
---

Fold consecutive tool calls and thinking into summary lines in fullscreen mode, and no longer show the Activated skill card for skills the model loads; to keep the previous layout, turn off Tool grouping and Group thinking in /settings, or set `tools = "off"` and `group_thinking = false` under `[transcript.group]` in tui.toml. While grouping is on, the footer no longer shows the ctrl+o expand or collapse hint.
