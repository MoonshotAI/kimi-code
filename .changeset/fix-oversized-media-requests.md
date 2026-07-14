---
"@moonshot-ai/kimi-code": patch
---

Prevent oversized image reads from poisoning sessions and recover existing request-too-large failures by removing unsafe media from provider requests.
