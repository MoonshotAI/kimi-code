---
"@moonshot-ai/kimi-code": patch
---

Stop rewriting the current session's system prompt when plugins are installed, enabled, disabled, removed, or reloaded; the running session keeps its original prompt and the change takes effect in new sessions.
