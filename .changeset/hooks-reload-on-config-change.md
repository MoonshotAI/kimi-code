---
"@moonshot-ai/kimi-code": patch
---

Rebuild the external-hook index when the config changes so `[[hooks]]` that arrive after engine construction (e.g. the interactive TUI loading config.toml) fire instead of silently never running.
