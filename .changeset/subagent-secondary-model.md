---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kimi-code": minor
---

Add a configurable secondary model for subagents: newly spawned subagents bind to it by default instead of inheriting the main agent's model, and the main agent can opt back into the primary model per spawn. Set `[subagent] model` (and optionally `effort`) in `config.toml`, or `KIMI_SUBAGENT_MODEL` / `KIMI_SUBAGENT_EFFORT`. Resumed subagents now keep the model they were created with instead of switching to the parent agent's current model — resuming one requires that model to still be configured.
