---
"@moonshot-ai/kimi-code": patch
---

The session prompt submission API now accepts an optional `skills` field: one or more named skills activate together with the prompt as a single bundled turn (one undo unit), validated up front with zero side effects on rejection.
