---
'@moonshot-ai/agent-core-v2': patch
---

Run the plan-mode tool guard on the native tool-executor hook chain: plan approvals are awaited inline in the starting hook instead of being deferred through the legacy two-phase event emitter.
