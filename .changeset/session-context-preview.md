---
"@moonshot-ai/kap-server": patch
"@moonshot-ai/agent-core-v2": patch
---

Add `GET /api/v1/sessions/{session_id}/context/summary`, `/context/items`, and `/context/items/{item_id}`, which return an unresolved read-only snapshot of the agent's system prompt, baseline tool definitions, and raw messages for context inspection and token estimation.
