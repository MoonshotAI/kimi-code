---
"@moonshot-ai/kimi-code": patch
---

web: Fix the context usage indicator dropping to 0 when a session is reopened or the session list reloads (e.g. after a sidebar search) — the cached live usage is now kept instead of the session record's all-zero placeholder.
