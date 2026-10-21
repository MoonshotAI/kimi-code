---
"@moonshot-ai/kimi-code": patch
---

Sanitize outgoing LLM request messages so a session with corrupted history stops failing with repeated 400s; set KIMI_CODE_REQUEST_SANITIZE=off to disable.
