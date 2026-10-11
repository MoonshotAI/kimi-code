---
"@moonshot-ai/kimi-code": patch
---

Omit max_tokens for models without an explicit output limit, fixing repeated 400 errors on strict serving stacks (e.g. bare vLLM) when the model's max output size is unknown.
