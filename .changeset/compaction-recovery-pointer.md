---
"@moonshot-ai/kimi-code": minor
---

After compaction, point the model at the session's event log with the line ranges of each earlier context window so it can look up exact details instead of guessing; disable with `KIMI_CODE_EXPERIMENTAL_COMPACTION_RECOVERY_POINTER=0`.
