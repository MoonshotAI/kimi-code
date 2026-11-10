---
"@moonshot-ai/kimi-code": patch
---

Report a session as busy while it has queued prompts, and reject `POST /sessions/{id}:reload` with 40901 until the queue drains.
