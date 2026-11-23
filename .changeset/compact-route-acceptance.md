---
"@moonshot-ai/kap-server": patch
---

`POST /sessions/{id}:compact` now queues behind running work instead of rejecting it; the response returns `accepted_as` and `prompt_id`, and 40910 is reserved for a compaction that is already running or queued.
