---
"@moonshot-ai/kimi-code": minor
---

Add a subagent model pool on the v2 engine: set `[subagent] default_model` in config.toml so spawned subagents use that model by default, or define a `[subagent.models]` table (alias → description) to let the main agent pick a pool alias or `primary` per spawn. The `/secondary_model` command now writes this setting; the legacy `[secondary_model]` section and its env vars still apply on the default engine only.
