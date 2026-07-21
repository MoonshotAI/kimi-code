---
"@moonshot-ai/kosong": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Honor the thinking-disable semantics declared by the models.dev catalog: selecting Off on a model whose effort levels include `none` (e.g. xai grok) now sends `none` on the wire instead of omitting the effort field, so reasoning actually turns off; models with effort levels but no way to disable thinking are treated as always-thinking and no longer offer an Off option. Bare Claude family aliases such as `sonnet-latest` on Anthropic-compatible providers also get their inferred effort levels back.
