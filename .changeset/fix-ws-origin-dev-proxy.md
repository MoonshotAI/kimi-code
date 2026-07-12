---
"@moonshot-ai/kimi-code": patch
---

Fix WebSocket connection failures in the bundled web UI's local dev mode when the browser opens on `localhost` while the server binds `127.0.0.1`.
