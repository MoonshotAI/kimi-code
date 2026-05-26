---
"@moonshot-ai/kimi-code": patch
---

Stop mentioning OAuth credentials in the migration UI — they are never migrated, so the previous "needs /login" notice misread as a failure. OAuth-only installs no longer trigger the migration screen.
