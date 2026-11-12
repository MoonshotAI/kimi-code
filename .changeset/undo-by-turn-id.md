---
"@moonshot-ai/kimi-code": patch
---

`POST /sessions/{id}:undo` now takes the `turn_id` and optional `agent_id` of the turn to undo and returns `removed_turn_ids`, instead of a `count` and a page of messages.
