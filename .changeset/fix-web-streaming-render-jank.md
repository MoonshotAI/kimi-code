---
"@moonshot-ai/kimi-code": patch
---

Keep the web chat responsive during long streaming replies by isolating live token text from the rest of the UI state, so it no longer stalls the main thread.
