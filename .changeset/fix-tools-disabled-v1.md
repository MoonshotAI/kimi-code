---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

fix(agent-core): honor [tools].disabled config in v1 engine

The `[tools].disabled` array in config.toml was silently ignored by the
v1 engine (v2 has a dedicated toolPolicy service for this). Read the
section from config.raw in bootstrapAgentProfile and merge it into the
profile's disallowedTools so disabled tools are filtered from both the
top-level tool list and the subagent Agent tool description.

agent-core is bundled into the SDK artifact (node-sdk `alwaysBundle`), so
in-process SDK consumers (createKimiHarness/SDKRpcClient v1 sessions)
that set `[tools].disabled` need the SDK version bumped to receive the
fix.
