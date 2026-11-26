---
"@moonshot-ai/agent-core-v2": patch
---

When a compaction request has to shrink because the history no longer fits the window, the provider reports a context overflow, or the summary comes back truncated or empty, summarize the leading messages and keep the rest of the history verbatim after the summary, so the request reuses the cached prompt prefix and no history is dropped. Trimming the oldest messages remains the fallback when the kept messages would take more than half of the compaction budget, such as after switching to a model with a much smaller window.
