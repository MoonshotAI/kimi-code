---
"@moonshot-ai/kimi-code": patch
---

Add a dedicated `[swarm] timeout_ms` config option (or the `KIMI_CODE_SWARM_TIMEOUT_MS` env var) for AgentSwarm subagent timeouts, which no longer follow `[subagent] timeout_ms`.
