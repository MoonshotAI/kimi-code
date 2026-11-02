---
"@moonshot-ai/kimi-code": patch
---

Remove the REST task endpoints (`GET /sessions/{id}/tasks`, `GET /sessions/{id}/tasks/{task_id}`, and the `:cancel` / `:detach` actions); use the WebSocket task frames and the `task.stop` / `task.background` requests instead.
