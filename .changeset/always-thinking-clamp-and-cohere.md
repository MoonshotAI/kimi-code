---
"@moonshot-ai/kosong": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Enforce always-on thinking on every wire: a model that declares `always_thinking` (e.g. a catalog-imported gpt-5) no longer resolves to a dishonest Off via `thinking.enabled = false` or an SDK/ACP off request — it clamps to the model's default effort instead of letting upstream keep reasoning while the UI reports Off. Cohere's proprietary SDK is now refused at catalog import instead of being guessed as OpenAI-compatible.
