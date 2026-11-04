---
"@moonshot-ai/kimi-code": minor
---

Fold consecutive tool calls and thinking into summary lines in fullscreen mode, and no longer show the Activated skill card for skills the model loads; to keep the previous layout, choose Show every tool call separately under Tool call folding and Don't fold thinking under Thinking folding in /settings, or set `tools = "off"` and `group_thinking = false` under `[transcript.group]` in tui.toml.
