---
"@moonshot-ai/pi-tui": patch
---

Use immutable snapshots for structured render results so reference-based conversion and parent caches remain correct without content comparisons. Preserve previous snapshots by returning new arrays and changed row objects when text, row order, or nested metadata changes. Keep legacy string rendering compatible with in-place array updates and large sparse outputs, and compose large outputs without exceeding function argument limits.
