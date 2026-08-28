---
'@moonshot-ai/kimi-code': patch
---

Sessions can now be opened by only one kimi-code instance at a time; opening a session already held elsewhere fails with an error naming the holding instance, and a crashed holder is taken over automatically.
