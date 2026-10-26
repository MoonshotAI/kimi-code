---
"@moonshot-ai/kimi-code": patch
---

Replace the server's WebSocket `event.approval.*` and `event.question.*` events with a single flat `interaction` frame, and replace `POST /sessions/{id}/approvals/{id}`, `POST /sessions/{id}/questions/{id}` and `POST /sessions/{id}/questions/{id}:dismiss` with `POST /sessions/{id}/interactions/{id}`; the old events and endpoints, along with `GET /sessions/{id}/approvals` and `GET /sessions/{id}/questions`, are removed.
