---
"@moonshot-ai/kap-server": patch
---

Stream each subscribed agent's queued prompts as a `queue` WebSocket frame and reorder them with `POST /sessions/{id}/agents/{agent_id}/queue/{prompt_id}:move`.
