---
"@moonshot-ai/kimi-code": patch
---

Reject conflicting modes on prompt submit and `POST /sessions/{id}/profile` instead of accepting them (tower cannot be combined with plan or swarm, and goal cannot start while tower or plan is on), and accept a prompt `mode` only when the prompt can start right away.
