---
"@moonshot-ai/kimi-code": minor
---

Allow enabled plugins to contribute agent system-prompt instructions under `kimi web` and experimental `kimi -p` through `systemPrompt` or `systemPromptPath` in `kimi.plugin.json`; live sessions pick up plugin changes, while the interactive TUI and default `kimi -p` path ignore these fields.
