---
'@moonshot-ai/protocol': minor
'@moonshot-ai/agent-core-v2': minor
---

Add a session-level exclusive lease: a session can now be held by only one kimi-code instance at a time. Resuming or creating a session already held by another instance fails with the new `session.locked` error (carrying the holder's pid, serverId, and lock timestamps); when the holder crashes or stops heartbeating, the next resumer takes over automatically, and the stale holder evicts itself from memory instead of writing to the wire journal.
