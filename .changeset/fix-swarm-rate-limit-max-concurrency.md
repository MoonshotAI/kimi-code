---
"@moonshot-ai/kimi-code": patch
---

Enforce `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` during `AgentSwarm` rate-limit retries and capacity recovery, not only during the initial launch ramp; unset or raise the variable to allow higher concurrency.
