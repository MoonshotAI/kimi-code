---
"@moonshot-ai/kimi-code": minor
---

web: Add experimental runtime model failover for subagents so exhausted retries or structured quota failures can replay the current step on an ordered fallback route. Enable `KIMI_CODE_EXPERIMENTAL_MODEL_FAILOVER=1` and configure `[subagent_failover]`.
