---
"@moonshot-ai/kimi-code": patch
---

`POST /sessions/{id}:compact` now queues the compaction behind running work instead of failing with 40910, and returns `{ accepted_as, prompt_id }`.
