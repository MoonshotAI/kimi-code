---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Add `default_swarm_mode` config option: when set to `true` in `config.toml`, every freshly created session starts in swarm mode (equivalent to `/swarm on`). Resumed sessions restore their own swarm state from records and are unaffected; `/swarm off` still overrides per session. Mirrors the existing `default_plan_mode` behavior.
