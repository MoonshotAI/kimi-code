---
"@moonshot-ai/kimi-code": patch
---

Server API sessions now get their agent profile, model, and thinking level when created; prompts no longer accept `profile`, so pass `agent_config.profile` when creating the session instead.
