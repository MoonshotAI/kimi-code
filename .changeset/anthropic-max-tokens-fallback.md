---
"@moonshot-ai/kimi-code": patch
---

Fix 400 rejections from Anthropic-compatible providers that enforce a lower max_tokens output limit than the default 128000 fallback. Custom endpoints now use a conservative 32768 default, and a rejected request is automatically retried with the provider's declared limit.
