---
"@moonshot-ai/kimi-code": patch
---

Remove `GET /sessions/{id}/status` and the `status` field of the `:undo` response; read the main agent's state from the WebSocket `agent` and `usage` frames instead.
