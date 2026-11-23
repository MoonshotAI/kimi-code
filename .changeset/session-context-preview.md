---
"@moonshot-ai/kap-server": patch
"@moonshot-ai/agent-core-v2": patch
---

Add `GET /api/v1/sessions/{session_id}/context/summary`, `/context/items`, and `/context/items/{item_id}`, which return the system prompt, tool definitions, and messages of the agent's next model request, built from a read-only preview that applies the same tool selection, media-tool hiding, and projection steps as the real request.
