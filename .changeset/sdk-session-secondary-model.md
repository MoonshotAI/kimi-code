---
"@moonshot-ai/kimi-code-sdk": minor
---

Add `Session.setSecondaryModel()` and `Session.getSecondaryModel()` for the session-scoped secondary model on the v2 engine. The v1 client rejects the setter with `NOT_IMPLEMENTED` and the getter reads back `undefined`.
