---
"@moonshot-ai/kimi-code": patch
---

Provision the managed Kimi Code search/fetch services during provider refresh so the WebSearch tool works after login without a manual `config.toml` edit. Previously the services block was only written on an explicit login, leaving upgraded clients with WebSearch silently disabled.
