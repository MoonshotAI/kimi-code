---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core-v2": patch
---

Fix background `Bash` tasks ignoring the `bash_task_timeout_s` config: a command started with `run_in_background=true` and no per-call `timeout` is now bounded by `bash_task_timeout_s` instead of the hardcoded 600s default.
