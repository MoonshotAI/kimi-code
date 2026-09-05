---
"@moonshot-ai/agent-core-v2": minor
---

Add an opt-in dedicated compaction model: when the `compaction-model` experiment is enabled and `[compaction_model]` is configured, context compaction uses that model instead of the current one, and transparently falls back to the current model if it errors or is inaccessible.
