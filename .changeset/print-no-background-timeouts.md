---
"@moonshot-ai/kimi-code": patch
---

In print mode (`kimi -p`), background Bash tasks and subagents no longer have a timeout by default — they run until they finish or the model stops them, and a foreground Bash command that times out is moved to the background without a new deadline. Interactive defaults are unchanged; tune per mode with `bash_task_timeout_s` under `[background]` or `timeout_ms` under `[subagent]` (`0` = no timeout).
