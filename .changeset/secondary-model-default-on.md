---
"@moonshot-ai/kimi-code": minor
---

The subagent model pool (`[secondary_model]`) now works without the removed `secondary-model` experiment — subagents bind the pool's `default_model`, and the `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL` env var no longer has any effect.
