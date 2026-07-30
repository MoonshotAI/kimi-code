---
"@moonshot-ai/kimi-code": patch
---

Remove the blocking `block`/`timeout` wait from the TaskOutput tool so checking a background task can no longer stall the conversation; it now always returns an immediate snapshot, and completion still arrives via automatic notification.
