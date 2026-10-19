---
"@moonshot-ai/kimi-code": patch
---

Stalled LLM streams are now aborted and retried after 90 seconds without stream events instead of hanging the session forever.
