---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Fail fast on quota/balance-exhausted HTTP 429 errors (e.g. Moonshot `exceeded_current_quota_error`, OpenAI `insufficient_quota`) instead of silently retrying for ~3 minutes. Transient rate-limit 429s keep the existing retry, backoff, and Retry-After behavior.
