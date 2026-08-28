---
"@moonshot-ai/kimi-code": minor
---

The subagent model pool (`[secondary_model]`) is now a permanent feature rather than an experiment: subagents bind the pool's `default_model`, and the `Agent` / `AgentSwarm` tools expose the `model` parameter when a pool is configured. The `secondary-model` experiment and its `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL` env var are removed and now have no effect.
