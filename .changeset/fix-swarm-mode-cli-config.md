---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Fix default swarm mode handling: preserve explicit `--no-swarm`, reapply `--swarm` after session replay, and persist `default_swarm_mode` to the config file.
