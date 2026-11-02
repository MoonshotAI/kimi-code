---
"@moonshot-ai/kimi-code": patch
---

`POST /sessions/{id}:compact` now waits for the running turn and runs before queued prompts instead of failing with 40910, and returns `{ accepted_as, prompt_id }`.
