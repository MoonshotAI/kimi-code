---
"@moonshot-ai/kimi-code": patch
---

`POST /sessions/{id}:compact` now queues the compaction behind the running turn and any queued prompts instead of failing with 40910, and returns `{ accepted_as, prompt_id }`.
