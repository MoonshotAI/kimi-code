---
"@moonshot-ai/kimi-code": patch
---

Report context compaction as the `compacting` status of the WebSocket `agent` frame and request retries on the running turn; the `agent` frame no longer carries `compacting`, `retry`, `turn_number` or `prompt_id`.
