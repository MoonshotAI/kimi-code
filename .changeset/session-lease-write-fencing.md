---
"@moonshot-ai/kimi-code": patch
---

Opening the same session from a second instance now fails with a clear ownership error, while shutdown blocks late writes and releases ambiguous closes through a dirty fallback.
