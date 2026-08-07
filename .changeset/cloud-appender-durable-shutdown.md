---
"@moonshot-ai/agent-core-v2": patch
---

Make CloudAppender shutdown durable: serialize flush() to prevent concurrent buffer races, add deadline-bounded shutdown() with AbortController that hands unsent events to durable storage and replays v2 spool data before completing.
