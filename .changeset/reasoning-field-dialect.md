---
"@moonshot-ai/kimi-code": patch
---

Fix loss of thinking content with OpenAI-compatible endpoints that return reasoning under a different field name (e.g. newer vLLM); the reasoning field is now detected per endpoint and echoed back on follow-up requests.
