---
"@moonshot-ai/agent-core-v2": patch
---

Session locks and session presence markers now also treat a holder as gone when its pid belongs to a process started after the lock or marker was written. The start time comes from `ps`; on Windows only the existing boot-time comparison applies.
