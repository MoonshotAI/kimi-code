---
"@moonshot-ai/kimi-code": minor
---

Fold consecutive tool calls and thinking into summary lines in fullscreen mode, and no longer show the Activated skill card for skills the model loads; to keep the previous layout, set `tool_call_density = "ungrouped"` and `thinking = "ungrouped"` under `[transcript]` in tui.toml.
