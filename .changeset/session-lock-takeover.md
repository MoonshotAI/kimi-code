---
"@moonshot-ai/kimi-code": patch
---

Offer to take over a session that is still in use after a retry, so sessions left locked by an exited process can be used again, and add a `KIMI_CODE_SESSION_LOCK=0` switch that turns off the session lock.
