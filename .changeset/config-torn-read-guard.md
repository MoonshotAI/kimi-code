---
"@moonshot-ai/kimi-code": patch
---

Fix models and providers transiently disappearing when config.toml is saved non-atomically by an external editor while the daemon reloads it.
