---
"@moonshot-ai/kimi-code": minor
---

Add an optional ‎`fork` parameter to the subagent and swarm tools that starts the subagent with a snapshot of the calling agent’s conversation history instead of an empty context. Experimental: enable it by setting `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK=true` or `subagent_fork = true` under `[experimental]` in config.toml.
