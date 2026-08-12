---
"@moonshot-ai/pi-tui": patch
---

Coalesce large non-bracketed stdin paste batches into one paste event and fold them to `[Pasted text #N]` markers (800 chars / >10 newlines).
