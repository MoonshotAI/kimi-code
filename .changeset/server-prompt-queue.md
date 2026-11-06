---
"@moonshot-ai/kimi-code": patch
---

Stream each subscribed agent's queued prompts over the server WebSocket as a `queue` frame, reorder them with `POST /sessions/{id}/agents/{agent_id}/queue/{prompt_id}:move`, and let `POST /sessions/{id}/prompts` take `delivery: "steer"` and report `accepted_as`.
