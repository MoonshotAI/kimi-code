---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kap-server": minor
"@moonshot-ai/protocol": minor
"@moonshot-ai/klient": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Add global tool gating (v2 engine only): a `[tools]` section in `config.toml` with `enabled` / `disabled` lists constrains every agent, and SDK / server prompt submissions accept a per-session `disabledTools` list (REST field `disabled_tools`). Set `[tools] disabled = ["Task"]` in `config.toml` to try it.
