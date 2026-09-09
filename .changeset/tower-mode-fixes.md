---
"@moonshot-ai/kimi-code": patch
---

Tower worker and reviewer briefings now carry the full mission context, and tower agent timeouts follow the subagent timeout setting (`[subagent] timeout_ms` or `KIMI_SUBAGENT_TIMEOUT_MS`), defaulting to 2 hours. Fix the /tasks list not showing the model for tower-spawned agents.
