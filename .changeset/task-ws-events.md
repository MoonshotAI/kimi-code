---
"@moonshot-ai/kimi-code": patch
---

Send task state over the server's WebSocket as a flat `task` frame instead of inside the transcript, and add `task.attach` / `task.detach` to stream a task's output as `task.output` frames; transcript frames and the REST transcript endpoints no longer carry tasks or task references, and their `tasks` field is removed.
