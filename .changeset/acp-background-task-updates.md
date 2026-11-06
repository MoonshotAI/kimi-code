---
"@moonshot-ai/kimi-code": patch
---

ACP: report background tasks that outlive a turn to the client. When `session/prompt` settles with background tasks still running (e.g. `Bash` with `run_in_background`), the session now pushes an in-flight `tool_call` per running task and a terminal `tool_call_update` when each one finishes, so ACP clients can track the work instead of never hearing about it.
