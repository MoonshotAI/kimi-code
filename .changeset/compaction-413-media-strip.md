---
"@moonshot-ai/kimi-code": patch
---

Retry a compaction whose summarizer request is rejected as too large (HTTP 413) with history media replaced by `[image]`/`[audio]`/`[video]` text markers, so /compact recovers in sessions that accumulated many screenshots instead of failing with the same error.
