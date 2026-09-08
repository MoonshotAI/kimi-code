---
"@moonshot-ai/kimi-code": patch
---

Fix misleading "compaction is blocked" message during automatic context compaction — the turn is waiting for compaction to finish and continues automatically; the old wording incorrectly told users to retry.
