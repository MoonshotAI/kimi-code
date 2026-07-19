---
"@moonshot-ai/kimi-code": minor
---

Add experimental per-workspace model and thinking-effort bindings for subagent types. Enable the `subagent-model-selection` experiment to bind configured model aliases to subagent types in `.kimi-code/local.toml`; bindings are applied mechanically at spawn (the calling agent cannot override them), are managed via the `/subagent-model` command, and resumed subagents always keep the model they were configured with.
