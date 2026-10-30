---
"@moonshot-ai/kimi-code": patch
---

Remove `GET /sessions/{id}/prompts`, both prompt `:steer` routes, and `POST /sessions/{id}:compact`, and reject agent settings such as `model`, `thinking`, and `permission_mode` on `POST /sessions/{id}/prompts`; set them through `POST /sessions/{id}/profile`, submit compactions with `compact` and steers with `delivery: "steer"`, and follow the server-side prompt queue through the `queue` WebSocket frame. Queued prompts no longer survive a server restart or a reload of a session that another client changed.
