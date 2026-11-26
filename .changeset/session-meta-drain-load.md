---
"@moonshot-ai/agent-core-v2": patch
---

Include the metadata document a session writes while loading in the pending metadata writes that draining waits for, so a close that starts before loading finishes no longer races that write.
