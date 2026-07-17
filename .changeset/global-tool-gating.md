---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kap-server": minor
"@moonshot-ai/protocol": minor
"@moonshot-ai/klient": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Add global tool gating (v2 engine only): a `[tools]` section in `config.toml` with `enabled` / `disabled` lists constrains every profile, and prompt submissions accept a session-persistent `disabledTools` list (REST field `disabled_tools`, SDK prompt options). Set `[tools] disabled = ["Task"]` in `config.toml`, or pass `disabledTools` when prompting through the SDK.
