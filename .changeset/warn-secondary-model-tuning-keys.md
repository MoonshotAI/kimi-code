---
"@moonshot-ai/kimi-code": patch
---

Warn when `[secondary_model]` sets model-tuning keys such as `max_context_size` or `capabilities`, which subagents never applied; set them on the `[models.<alias>]` entry instead.
