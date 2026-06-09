---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kosong": patch
---

Add per-role and per-invocation model selection for subagents.

A new `[subagent_models]` config.toml section maps subagent profile names
to model aliases so different roles (coder, explore, plan) can use
different LLM models. The Agent tool also accepts an optional `model`
parameter to override the model for a single invocation. When a subagent
uses a model that does not support thinking, the thinking level is
automatically disabled to avoid API errors.
