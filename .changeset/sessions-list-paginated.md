---
"@moonshot-ai/kimi-code": patch
---

The sessions list API now applies its filters while collecting so paged responses are full and `has_more` is accurate (an unsized request still returns the whole list), and the transcript ops catch-up API accepts a `limit` and reports `has_more`.
