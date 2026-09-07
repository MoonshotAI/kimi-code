---
"@moonshot-ai/kimi-code": patch
---

Warn at config load when a [models] entry lacks the `model` field (usually from an unquoted dotted TOML table name like `[models.kimi-k2.7-code]`) instead of leaving the alias silently unusable.
