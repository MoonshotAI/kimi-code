---
"@moonshot-ai/kap-server": patch
---

Report a session as busy while any agent queue is non-empty and reject `POST /sessions/{id}:reload` with 40901 until the queue drains.
