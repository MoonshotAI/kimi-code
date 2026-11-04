---
"@moonshot-ai/kimi-code": patch
---

Stream each subscribed agent's conversation over the server WebSocket as `turns`, `turns.failed`, `turn.*`, `item.*`, `turns.removed` and `notice` frames, page older turns with `GET /sessions/{id}/agents/{agent_id}/turns` and read plans from `GET /sessions/{id}/agents/{agent_id}/plans`; `subscribe_v2` takes `agent_ids` instead of transcript grades, prompts with bundled skills and skill activations accept a client `prompt_id`, and the transcript frames and the `GET /sessions/{id}/transcript` endpoints (with `/ops`, `/plan` and `/user-messages`) are removed.
