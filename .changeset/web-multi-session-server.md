---
"@moonshot-ai/kimi-code": minor
---

Let the web client keep several sessions open at once: subscribing to a session over WebSocket now resumes it on demand, and idle sessions are closed after `[server] session_idle_timeout_ms` (default 30 minutes) or beyond `[server] max_live_sessions` (default 16).
