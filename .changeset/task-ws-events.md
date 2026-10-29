---
"@moonshot-ai/kimi-code": patch
---

Send task state over the server's WebSocket as a `task` frame instead of inside the transcript; transcripts and the REST transcript endpoints no longer include tasks or task references, so read tasks from `task` frames or the REST task list.
