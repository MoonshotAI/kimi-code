---
"@moonshot-ai/kimi-code": patch
---

Fix a race where a heartbeat write in flight during server shutdown could recreate the instance file right after it was removed.
