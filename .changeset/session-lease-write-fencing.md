---
"@moonshot-ai/kimi-code": patch
---

Opening the same session from a second instance now fails with a clear ownership error instead of silently interleaving writes.
