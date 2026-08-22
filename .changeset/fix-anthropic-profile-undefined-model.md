---
"@moonshot-ai/kosong": patch
---

Fix a crash when a model config entry lacks the `model` field (e.g. from a malformed TOML key like `[models.kimi-k2.7-code]`): the Anthropic profile matchers now tolerate `undefined` model names and return no profile instead of throwing `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`.
