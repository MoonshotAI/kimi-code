---
"@moonshot-ai/kimi-code": patch
---

Queue prompts on the server and push the queue through the `queue` WebSocket frame; `POST /sessions/{id}/prompts` no longer accepts agent settings such as `model`, `thinking`, `permission_mode`, `swarm_mode`, `profile`, and `disabled_tools` — set `model`, `thinking`, and `permission_mode` through `POST /sessions/{id}/profile` and start plan, swarm, or goal with `mode` (the other settings have no REST replacement). Queued prompts no longer survive a server restart or a reload of a session that another client changed.
