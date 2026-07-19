---
"@moonshot-ai/kimi-code": patch
---

Fix cross-process state corruption from ad-hoc file locks: server and database locks now verify ownership before release, stale locks are taken over by a quarantine rename instead of deletion, and concurrent writes to the global config and workspace registry are serialized so updates are no longer lost.
