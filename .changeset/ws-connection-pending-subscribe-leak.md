---
"@moonshot-ai/kap-server": patch
---

Fix a closed WebSocket connection lingering in memory when it disconnects while a `subscribe_v2` is still awaiting session resume or transcript backfill. The pending subscription is now dropped and unregistered from the broadcaster when the socket closes mid-subscribe.
