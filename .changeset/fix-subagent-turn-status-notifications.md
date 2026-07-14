---
"@moonshot-ai/kimi-code": patch
---

Fix sub-agent completions being signaled as session turn completions, which fired premature completion notifications, sounds, and unread markers while the main turn was still running.
