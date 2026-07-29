---
"@moonshot-ai/kimi-code": patch
---

Fail fast on quota- or balance-exhausted errors instead of silently retrying for ~3 minutes; temporary rate limits keep the existing retry behavior.
