---
"@moonshot-ai/kimi-code": minor
---

Allow enabled plugins to contribute agent system-prompt instructions through `systemPrompt` or `systemPromptPath` in `kimi.plugin.json`, effective under `kimi web` and CLI surfaces with `KIMI_CODE_EXPERIMENTAL_FLAG=1` (including the experimental TUI); live sessions pick up plugin changes, while the default TUI and `kimi -p` paths ignore these fields.
