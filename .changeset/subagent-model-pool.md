---
"@moonshot-ai/kimi-code": minor
---

Add a declarative subagent model pool on the v2 engine: define a pool under `[subagent.models]` in config.toml (each key a configured model alias, each value a short description the main agent sees) and pick the fallback with `[subagent] default_model`. The `/secondary_model` command is removed. The experimental `[secondary_model]` section, the `KIMI_SECONDARY_MODEL` / `KIMI_SECONDARY_EFFORT` env vars, and the agent-file `model_preference` field keep working on the default engine and are ignored by the v2 engine.
