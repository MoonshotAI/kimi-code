---
"@moonshot-ai/kimi-code": patch
---

Cap the agent's in-turn wait for background tasks at 90 seconds (longer timeouts are no longer accepted), discourage repeated waits, and let a new message end the wait immediately.
