---
"@moonshot-ai/kimi-code": patch
---

Add a per-provider `free_models_only` setting for OpenAI-compatible providers. Set `free_models_only = true` in a provider's `[providers.<id>]` section so that `/refresh-catalog` keeps only free models (ids containing `free`).
