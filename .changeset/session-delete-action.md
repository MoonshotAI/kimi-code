---
"@moonshot-ai/kimi-code": patch
---

Expose permanent session deletion via `POST /api/v1/sessions/{session_id}:delete` and broadcast `event.session.deleted` over WebSocket.
