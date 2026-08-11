---
"@moonshot-ai/kimi-code": minor
---

Add a subagent model pool on the default v2 engine: set `[secondary_model] default_model` in config.toml so spawned subagents use that model by default, or define a `[secondary_model.models]` table (alias → description) to let the main agent pick a pool alias or `primary` per spawn. The `/secondary-model` command (alias `/subagent-model`, renamed from the experimental `/secondary_model`) now writes this setting; the legacy `[secondary_model]` recipe keys and their env vars apply only on the legacy `agent-core` engine selected with `KIMI_CODE_LEGACY_FLAG=1`.
