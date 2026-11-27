---
"@moonshot-ai/kimi-code": patch
---

Compaction close to the context window now summarizes the earliest messages instead of dropping them, and a summary that reaches the output limit fails the compaction instead of being retried.
