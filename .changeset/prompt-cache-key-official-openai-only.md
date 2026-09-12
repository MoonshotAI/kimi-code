---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Only send the OpenAI prompt cache key to the official OpenAI API; custom OpenAI-compatible endpoints no longer receive the unknown parameter and stop rejecting requests with HTTP 400.