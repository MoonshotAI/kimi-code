---
"kimi-code-app": patch
---

Renaming a model provider in settings now changes only its display name, so the sessions that use its models keep working and no main process error appears; its key in config.toml and its model aliases stay the same.
