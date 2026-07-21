---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Add environment variable overrides for agent loop and background task limits. Set KIMI_LOOP_MAX_STEPS_PER_TURN, KIMI_LOOP_MAX_RETRIES_PER_STEP, or KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS to take priority over the [loop_control] and [background] config.
