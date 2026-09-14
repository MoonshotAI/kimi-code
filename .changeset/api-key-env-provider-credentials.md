---
"@moonshot-ai/kimi-code": minor
---

Providers can read their API key from an environment variable instead of storing it in `config.toml`: set `api_key_env = "YOUR_KEY_NAME"` on the provider. Custom registries declaring `env` import this way automatically, and `kimi provider add` no longer requires `--api-key` for public registries.
