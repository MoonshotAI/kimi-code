---
"@moonshot-ai/kimi-code": patch
---

web: Fix the first visit after starting or updating the web UI bouncing to the login page when the initial auth check fails; the connecting screen now stays up, shows the connection error, and retries until the server answers.
