---
"@moonshot-ai/kimi-code": patch
---

fix(agent-core): honor [tools].disabled config in v1 engine

The `[tools].disabled` array in config.toml was silently ignored by the
v1 engine (v2 has a dedicated toolPolicy service for this). Read the
section from config.raw in bootstrapAgentProfile and merge it into the
profile's disallowedTools so disabled tools are filtered from both the
top-level tool list and the subagent Agent tool description.
