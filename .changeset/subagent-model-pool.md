---
"@moonshot-ai/kimi-code": minor
---

Add a configurable model pool for spawned subagents behind the `secondary-model` experiment (`KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`, or the master flag): with the experiment on, the `/secondary-model` command or the `[secondary_model]` section in config.toml sets a default model or a small named pool that the main agent picks from per spawn. A lone legacy `model` key in the same section keeps working as the fallback default.
