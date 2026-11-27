---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code-oauth": patch
"@moonshot-ai/kimi-code-product": patch
---

Fetch the `auto_review` named client configuration for managed Kimi Code sessions and resolve Auto Review bindings as `[auto_review]` over cloud defaults over the main model, removing the `[secondary_model]` fallback. Cloud-supplied models, efforts, and timeouts apply only to managed Kimi Code models and fall back silently when unavailable or unsupported; a cloud effort never overrides `[thinking].enabled = false` or `KIMI_MODEL_THINKING_EFFORT`. The shared named client configuration client is exported from `@moonshot-ai/kimi-code-oauth` and re-exported by `@moonshot-ai/kimi-code-product`.
