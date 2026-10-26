---
"@moonshot-ai/kimi-code": patch
---

Stop showing a failed swarm for `AgentSwarm` calls rejected before any subagent starts, such as while swarm mode is off; after such a rejection, the agent points you to `/swarm` if you asked for a swarm.
