---
"@moonshot-ai/kimi-code": patch
---

Fail closed when the tool policy cannot be loaded: an unreadable `config.toml` or invalid `[tools]` section now blocks agent startup instead of continuing in degraded mode with an empty policy.
