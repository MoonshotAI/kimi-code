---
"@moonshot-ai/kimi-code": patch
---

Tower worker and reviewer briefings now carry the mission's user-verbatim context, and reviewers also see the full mission text and the worker's review request. Tower worker and reviewer agent timeouts now follow the subagent timeout setting (`[subagent] timeout_ms` or `KIMI_SUBAGENT_TIMEOUT_MS`), still defaulting to 2 hours. Fix the /tasks list not showing the model for tower-spawned worker and reviewer agents.
