---
"@moonshot-ai/kimi-code": patch
---

Stop letting the main agent run Agent and AgentSwarm subagents on its own model through an implicit `primary` choice when a subagent model pool is configured; add the main model's alias to `[secondary_model.models]` to offer it again.
