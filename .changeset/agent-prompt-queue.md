---
"@moonshot-ai/agent-core-v2": patch
---

Expose the agent prompt queue: prompt submissions report whether they start a turn immediately or queue, `moveQueued` reorders queued prompts, `onDidChangeQueue` publishes visible queue changes, and a non-empty agent queue now counts as session activity.
