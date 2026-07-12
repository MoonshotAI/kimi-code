---
"@moonshot-ai/kimi-code": patch
---

Add a `subagent.timeout_ms` config option to control how long a single subagent may run before timing out, and raise the default from 30 minutes to 2 hours. Set `[subagent] timeout_ms` in config.toml (or the `KIMI_SUBAGENT_TIMEOUT_MS` env var) to adjust it.
