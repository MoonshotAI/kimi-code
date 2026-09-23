---
"@moonshot-ai/kimi-code": minor
---

Add experimental multi-session support to `kimi web`, enabled with `KIMI_CODE_EXPERIMENTAL_WEB_MULTI_SESSION=1`: subscribing to a session over WebSocket resumes it on demand, and unused sessions are unloaded after `[server] session_idle_timeout_ms` (default 30 minutes) or beyond `[server] max_live_sessions` (default 16).
