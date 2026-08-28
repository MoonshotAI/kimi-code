---
"@moonshot-ai/kimi-code": minor
---

The subagent model pool (`[secondary_model]`) is now enabled by default: configured subagents bind the pool's `default_model` and the `Agent` / `AgentSwarm` tools gain the `model` parameter. Set `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=0` to restore the inherit-only behavior.
