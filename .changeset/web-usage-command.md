---
"@moonshot-ai/kimi-code": minor
---

Add the `/usage` command to the web UI. It opens a usage panel showing session token usage, the context window, managed plan quotas (with per-limit progress and reset hints), and the Extra Usage wallet, mirroring the TUI `/usage` report. Plan data is fetched fresh from `GET /api/v1/oauth/usage` each time the panel opens.
