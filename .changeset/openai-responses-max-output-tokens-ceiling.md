---
"@moonshot-ai/kimi-code": patch
---

Fix 400 errors from OpenAI-compatible Responses API providers (such as the official DeepSeek endpoint) caused by sending a max_output_tokens value above the provider's limit. Explicitly configured max_output_size values are now honored as-is instead of being clamped to 128k.
