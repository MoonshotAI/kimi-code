---
"@moonshot-ai/kimi-code": patch
---

Stop sending the Moonshot-only prompt_cache_key field to other OpenAI-compatible providers, which rejected it with a 400 error and broke native-LLM turns.
