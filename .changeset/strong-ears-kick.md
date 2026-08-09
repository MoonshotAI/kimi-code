---
"@moonshot-ai/kimi-code": patch
---

Stop sending the `prompt_cache_key` parameter to third-party OpenAI-compatible providers (NVIDIA NIM, Azure Foundry, etc.) that reject it with a 400 error. Only official OpenAI endpoints and Kimi now receive this parameter.