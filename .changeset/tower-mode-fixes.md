---
"@moonshot-ai/kimi-code": patch
---

Tower mode (experimental, `KIMI_CODE_EXPERIMENTAL_TOWER=1`): fix tower mode never starting when enabled through `[experimental] tower = true` in `config.toml` instead of the environment variable. When tower mode cannot be enabled, the error now names the actual blocker — the disabled experiment, a required restart, or the owning session. When another live session owns the workspace tower, the message also names the owning session's title alongside its id.
