---
"@moonshot-ai/agent-core-v2": patch
---

Wait for an automatic compaction that is already running before starting the next step, so a `compaction_trigger_ratio` below the blocking threshold compacts at that ratio instead of racing the step and discarding the summary. When a turn waits on a compaction that is discarded because history changed, compact the current history again instead of ending the turn as cancelled.
