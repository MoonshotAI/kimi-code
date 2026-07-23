---
"@moonshot-ai/kimi-code": patch
---

Decouple the transcript WebSocket stream from the legacy agent filter: transcript frames are now governed by the per-agent transcript grades alone, so a connection no longer silently drops transcript data for agents missing from its event allowlist.
