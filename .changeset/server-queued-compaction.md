---
"@moonshot-ai/kimi-code": patch
---

Queue `POST /sessions/{id}:compact` behind running work instead of rejecting it; the response now returns `accepted_as` and `prompt_id`.
