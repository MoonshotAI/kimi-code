---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Allow `primary` as an ordinary `[secondary_model]` model alias and remove the reserved `PRIMARY_SUBAGENT_MODEL_CHOICE` SDK export; Tower reviewers now use the pool default instead of the primary model and no longer accept the special `model: "primary"` escape hatch, so primary-model reviews require explicitly selecting a pool alias for the primary model or setting it as `default_model` for all spawns.
