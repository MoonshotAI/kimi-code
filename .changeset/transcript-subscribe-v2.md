---
"@moonshot-ai/kimi-code": minor
---

Move transcript stream subscriptions on the server WebSocket protocol to a dedicated `subscribe_v2` control frame paired with an agent-grained `unsubscribe_v2`; the `transcript` and `transcript_since` fields on `client_hello` and `subscribe` are no longer accepted.
