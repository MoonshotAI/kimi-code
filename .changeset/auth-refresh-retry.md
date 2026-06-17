---
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/kimi-code": patch
---

Show the underlying connection error when OAuth token refresh fails after internal retries, instead of prompting for login. Token refresh failures are no longer re-retried at the agent loop level.
