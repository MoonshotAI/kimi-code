---
"@moonshot-ai/kimi-code-sdk": minor
---

Remove the secondary-model session API `Session.applyPersistedSecondaryModel`; subagent model selection is configured via `[secondary_model]` in config.toml instead. The `SECONDARY_DERIVED_MODEL_ALIAS` export stays (the v1 engine still synthesizes the entry at runtime, so hosts keep filtering it out of model pickers), and the SDK now also exports `PRIMARY_SUBAGENT_MODEL_CHOICE`, the v2 subagent model pool's reserved `primary` key.
