---
"@moonshot-ai/kimi-code": patch
---

Track files read and written per session to detect conflicting edits across server instances: with multi-server mode enabled, stale or never-read file writes are rejected, otherwise they are flagged in the tool result.
