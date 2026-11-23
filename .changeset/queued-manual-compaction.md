---
"@moonshot-ai/agent-core-v2": patch
---

Manual compaction can now be requested while the agent is busy: the request waits in a per-agent queue and runs at the next step boundary or when the loop goes idle, instead of failing. A request made while a compaction is already running or queued is still rejected.
