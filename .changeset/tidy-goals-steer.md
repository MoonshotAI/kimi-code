---
"@moonshot-ai/kimi-code": minor
---

Fix messages sent during an autonomous goal run being queued behind the running turn instead of steering into it. The `GET /api/v1/sessions/{session_id}/prompts` endpoint for listing a session's prompts has been removed; follow the prompt lifecycle events and the session snapshot's current_prompt_id instead. UserPromptSubmit and UserPromptQueued hook scripts now fire for every tracked prompt — including goal continuations and other feature-originated prompts, and prompts steered into a running turn — and their payload gains an `origin` field for filtering; previously they fired only for user prompts.
