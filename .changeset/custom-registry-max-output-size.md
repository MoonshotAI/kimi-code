---
"@moonshot-ai/kimi-code": patch
---

Fix 400 "Invalid max_tokens" errors for models imported from a custom registry (api.json) by recording each model's advertised output token limit.
