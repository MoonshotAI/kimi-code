---
"@moonshot-ai/kimi-code": patch
---

Fix the web UI repeatedly losing its realtime connection every ~30 seconds when the server runs behind a reverse proxy or gateway with an idle connection timeout; the server now sends a WebSocket heartbeat and only closes connections that stop responding entirely.
