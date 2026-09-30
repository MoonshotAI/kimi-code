---
"@moonshot-ai/kimi-code": minor
---

After `/reload`, the agent is now told what changed externally: modified or new AGENTS.md files, added or removed skills, and subagent profile or model changes. The same reload with change notifications is available on the server as `POST /api/v1/sessions/{session_id}:reload`.
