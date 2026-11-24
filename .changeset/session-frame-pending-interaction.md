---
"@moonshot-ai/kap-server": patch
---

Report the pending interaction as it is at the moment a `session` update frame is sent over WebSocket, so a session frame no longer reports `pending_interaction: "none"` after the frame of an interaction that is still pending. The other fields of a frame pushed for an activity change still describe that change.
