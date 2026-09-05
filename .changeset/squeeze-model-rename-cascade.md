---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": minor
---

Rename `/compaction-model` to `/squeeze-model` so `/comp` + Tab autocompletes to `/compact` again (the old name shadowed it and broke muscle memory), and add `/squeeze-model-secondary`: a fallback squeeze model that extends compaction into a three-tier cascade — squeeze model → secondary squeeze model → current conversation model. The secondary is tried when the primary squeeze model is unset or unavailable (not in the catalog, or failing at runtime), persisted as `[compaction_model] secondary_model`, and shown on the "Compacting context using <model>..." indicator when it takes over. Both commands enable the `compaction-model` experiment on save; the engine flag id, config section, and existing `[compaction_model] model` values are unchanged.
