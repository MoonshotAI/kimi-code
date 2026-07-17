---
"@moonshot-ai/minidb": minor
"@moonshot-ai/kimi-code": patch
---

Cluster readers of the embedded key-value engine now catch up incrementally by replaying only newly appended WAL frames after another process writes, instead of fully reopening the shard on every read; cross-process read latency drops by orders of magnitude at larger shard sizes, and readers still fall back to a full reopen after WAL rotation or truncation.
