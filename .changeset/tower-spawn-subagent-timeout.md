---
"@moonshot-ai/kimi-code": patch
---

Tower worker and reviewer agent timeouts now follow the subagent timeout setting (`[subagent] timeout_ms` or `KIMI_SUBAGENT_TIMEOUT_MS`), still defaulting to 2 hours.
