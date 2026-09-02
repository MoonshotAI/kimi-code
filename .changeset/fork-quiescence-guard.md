---
"@moonshot-ai/kimi-code": minor
---

Forking a session is now refused while it still has a queued prompt or while another fork of it is copying, so a fork never captures a session that is about to change.
