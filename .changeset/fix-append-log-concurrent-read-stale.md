---
'@moonshot-ai/core': patch
'@moonshot-ai/agent-core-v2': patch
'@moonshot-ai/kap-server': patch
---

Account for in-process appends and rewrites when finalizing append-log reads so concurrent writes during streaming reads are not misclassified as external modifications, allow non-blocking session run gate probes to release the lock without throwing on stale sessions, and automatically reload stale sessions during WebSocket subscription and conversation turn fetches.
