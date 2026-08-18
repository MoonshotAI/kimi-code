---
"@moonshot-ai/kimi-code": patch
---

Stop sending the OpenAI prompt cache key to custom OpenAI-compatible endpoints, which reject the unknown field with a 400 error; the key is still sent to the official OpenAI API.
