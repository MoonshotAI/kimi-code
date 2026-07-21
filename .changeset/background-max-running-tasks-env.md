---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Add an environment variable override for the background task concurrency cap. Set KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS to take priority over the [background] max_running_tasks config.
