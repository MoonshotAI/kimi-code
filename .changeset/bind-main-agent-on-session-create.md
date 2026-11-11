---
"@moonshot-ai/kimi-code": patch
---

The server API now fixes a session's agent profile, model, and thinking level when the session is created, so a thinking level given without a model is no longer lost; prompts no longer accept `profile`, so choose the agent profile with `agent_config.profile` when creating the session.
