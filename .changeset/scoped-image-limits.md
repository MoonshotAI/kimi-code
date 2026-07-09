---
"@moonshot-ai/kimi-code": patch
---

The `[image]` limits in config.toml now also apply to pasted images (CLI paste and ACP prompts), and each core now uses its own settings, so reloading one client's config no longer changes another client's image compression.
