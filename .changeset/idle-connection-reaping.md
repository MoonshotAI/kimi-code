---
"@moonshot-ai/kimi-code": minor
---

Remote environment connections now close after 5 minutes without active use and reconnect automatically on the next tool call. Set `idleTtlSeconds` on an environment entry to change the timeout, or `0` to keep the connection open.
