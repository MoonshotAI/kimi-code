---
"@moonshot-ai/kimi-code": patch
---

Add an on-demand `/refresh-catalog` command that fetches models from OpenAI-compatible providers' `/models` endpoints, preserves curated `maxContextSize` values (e.g. 1M windows imported from models.dev), and enriches model names and capabilities from the models.dev catalog. OpenAI-compatible providers are no longer refreshed automatically on startup, so their curated context windows are never clobbered.
