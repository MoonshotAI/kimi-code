---
"@moonshot-ai/kimi-code": patch
---

Add a `[secondary_model]` config section for running newly spawned subagents on a second model instead of inheriting the main agent's model; invalid aliases now fail before an agent is registered. Effective in `kimi web` and experimental `kimi -p` only. Set `[secondary_model] model` in `config.toml` (or `KIMI_SECONDARY_MODEL`) to use it.
