---
"@moonshot-ai/kimi-code": patch
---

Remove `GET /sessions/{id}/prompts`, both prompt `:steer` routes, and `POST /sessions/{id}:compact`, and reject agent settings such as `model`, `thinking`, `permission_mode`, `profile`, and `disabled_tools` on `POST /sessions/{id}/prompts`; set `model`, `thinking`, and `permission_mode` through `POST /sessions/{id}/profile` (`profile` and `disabled_tools` have no REST replacement), submit compactions with `compact` and steers with `delivery: "steer"`, and follow the server-side prompt queue through the `queue` WebSocket frame. Queued prompts no longer survive a server restart or a reload of a session that another client changed.
