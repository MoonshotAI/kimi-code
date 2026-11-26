---
"kimi-code-app": patch
---

When the conversation outgrows the context window before compaction runs, keep the latest messages verbatim instead of dropping the oldest ones; earlier user messages then survive only in the summary, and no setting keeps them verbatim.
