---
"@moonshot-ai/kimi-code": minor
---

Add a session API endpoint that returns all turn-opening user messages of a session, grouped per agent. Query `GET /api/v1/sessions/{session_id}/transcript/user-messages` (optionally with `?agent_id=` for a single agent) to fetch them.
