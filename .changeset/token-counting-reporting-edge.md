---
"@moonshot-ai/kimi-code": minor
---

The `[token_counting]` strategy now only selects the reported context size: `estimated` keeps provider-reported usage out of the context-size display, and `measured` no longer gets stuck retrying an oversized compaction request until it fails.
