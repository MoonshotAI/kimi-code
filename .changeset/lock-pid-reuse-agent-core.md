---
"@moonshot-ai/agent-core-v2": patch
---

Session locks and session presence markers now detect reused pids on both POSIX (via `ps` process start time) and Windows (via a per-process named pipe recorded in an optional `liveness` field; legacy locks without `liveness` still fall back to the boot-time comparison).
