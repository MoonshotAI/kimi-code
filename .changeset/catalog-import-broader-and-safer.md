---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/kimi-code": patch
---

Import many more providers from the models.dev catalog: vendor SDKs like xai and openrouter now import instead of being refused (with a "guessed" note), deprecated and alpha models are filtered out, per-model gateway protocol and endpoint overrides are honored, and context limits are correct (input limit for compaction, total window for completion). Imports lacking a usable endpoint now ask for one via `--base-url` or a prompt.
