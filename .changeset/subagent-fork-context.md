---
"@moonshot-ai/kimi-code": minor
---

Add an optional `fork` parameter to subagent and swarm tools that starts the subagent with a snapshot of the calling agent's conversation history; set `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK=1` or `subagent_fork = true` under `[experimental]` in config.toml to enable it.
