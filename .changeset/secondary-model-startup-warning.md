---
"@moonshot-ai/kimi-code": patch
---

Validate the configured `[secondary_model]` at session start and warn early when the model cannot be resolved or the effort is not supported, instead of only failing when a subagent is spawned.
