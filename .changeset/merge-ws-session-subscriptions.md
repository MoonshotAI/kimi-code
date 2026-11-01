---
"@moonshot-ai/kimi-code": patch
---

Remove the server's WebSocket `subscribe` / `unsubscribe` frames with their cursor replay and `resync_required`, `GET /sessions/{id}/snapshot`, and the session `last_seq` field; subscribe to sessions with `subscribe_v2` and send it again after reconnecting. `event.session.work_changed` now reaches every connection for every live session.
