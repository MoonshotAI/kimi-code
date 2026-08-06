---
"@moonshot-ai/kimi-code": patch
---

Restore how the last turn ended (completed, cancelled, or failed) when a session is resumed after a server restart, so clients can still surface a previously failed turn instead of the session looking silently stopped.
