---
"@moonshot-ai/kimi-code": patch
---

Fix cancelled model requests being wrapped as retryable provider errors, so interrupting a request no longer triggers silent retries.
