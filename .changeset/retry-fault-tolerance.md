---
"@moonshot-ai/kimi-code": patch
---

Retry provider 429, overload, and other transient errors more reliably, honoring the server Retry-After delay, and surface retries in `-p --output-format stream-json`.
