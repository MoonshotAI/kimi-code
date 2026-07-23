---
"@moonshot-ai/kimi-code": major
---

Add a `[secondary_model]` config section for running newly spawned subagents on a second model instead of inheriting the main agent's model; Agent files can set `model_preference: primary` or `model_preference: secondary` as their symbolic default, and an explicit tool argument takes precedence. Resumed subagents keep their own model and require that alias to remain configured, while invalid aliases fail before an agent is registered. Effective in `kimi web` and experimental `kimi -p` only. Set `[secondary_model] model` in `config.toml` (or `KIMI_SECONDARY_MODEL`) to use it.
