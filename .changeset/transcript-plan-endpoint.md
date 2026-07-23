---
"@moonshot-ai/kimi-code": minor
---

Add a server endpoint to look up the plan content and review outcome of ExitPlanMode calls. Query `GET /api/v1/sessions/{session_id}/transcript/plan` with `agent_id`, plus an optional `tool_call_id` to narrow to one call.
