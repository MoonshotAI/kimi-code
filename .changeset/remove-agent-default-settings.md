---
"kimi-code-app": patch
---

Remove the default model, default permission and default plan mode settings; new sessions use the model and permission last picked in the composer, and `default_plan_mode` in config.toml still applies.
