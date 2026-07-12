---
"@moonshot-ai/kimi-code": patch
---

Make the wire transcript reader resilient to individual corrupted lines so the web UI and CLI can still load a session transcript even when a crash left the wire file in a partially-written state.