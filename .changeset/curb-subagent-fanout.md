---
"@moonshot-ai/kimi-code": patch
---

Curb unnecessary subagent fan-out in ordinary tasks: the Agent tool guidance now tells the model not to create or call subagents unless the user requested them, and AgentSwarm guidance applies only when the user asked for a swarm or many parallel agents.
