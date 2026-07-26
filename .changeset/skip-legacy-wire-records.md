---
"@moonshot-ai/kimi-code": patch
---

Fix spurious "Unknown wire record type" errors when restoring sessions whose history contains records the engine deliberately no longer replays, such as those from the retired micro-compaction experiment.
