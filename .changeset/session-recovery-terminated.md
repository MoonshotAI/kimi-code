---
"@moonshot-ai/kosong": patch
---

Retry a dropped provider stream instead of failing the turn. A raw undici `terminated` error (an SSE/HTTP response body cut mid-flight, common on long streaming responses) is now classified as a retryable `APIConnectionError` on the Anthropic path — matching the OpenAI path, which already recognized it — so a transient stream drop is retried rather than surfaced as a fatal error.
