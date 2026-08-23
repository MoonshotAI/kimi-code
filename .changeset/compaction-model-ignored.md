---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core-v2": patch
---

Fix the dedicated compaction model being ignored at compaction time: `/compaction-model` now persists the engine-contract pointer `[compaction_model] model` (previously it wrote `default_model`, which the resolver never read) and enables the `compaction-model` experiment flag on save, so the pick actually takes effect on a default build. `/visual-model` gets the same fix (pointer + flag). The engine resolvers additionally honor the legacy `default_model` as a fallback pointer, so configs written by the older TUI start working instead of staying silently dead.
