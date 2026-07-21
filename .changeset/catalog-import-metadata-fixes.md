---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Consume more of the metadata the models.dev catalog declares: deprecated models are no longer offered for import, per-model Anthropic protocol and endpoint overrides on gateway providers are honored, and a model's declared input token limit (e.g. gpt-5) now sizes the context budget instead of the larger total window.
