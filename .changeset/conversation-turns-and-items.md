---
"@moonshot-ai/kimi-code": patch
---

Stream each subscribed agent's conversation over the server WebSocket as `turns`, `turns.removed`, `turns.failed`, `turn.*`, `item.*` and `notice` frames, and page older turns with `GET /sessions/{id}/agents/{agent_id}/turns`; `subscribe_v2` takes `agent_ids` instead of transcript grades, prompts with bundled skills and skill activations accept a client `prompt_id`, and the transcript frames and the `GET /sessions/{id}/transcript` endpoints (with `/ops`, `/plan` and `/user-messages`) are no longer available.
