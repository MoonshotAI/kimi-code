---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Add environment variable overrides for the agent loop limits. Set KIMI_LOOP_MAX_STEPS_PER_TURN or KIMI_LOOP_MAX_RETRIES_PER_STEP to take priority over the [loop_control] config.
