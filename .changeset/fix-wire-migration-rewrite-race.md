---
"@moonshot-ai/kimi-code": patch
---

Fix possible record loss when resuming sessions whose wire log needs migration, and reject session logs missing the version envelope instead of silently misreading them.
