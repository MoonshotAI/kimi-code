---
"@moonshot-ai/kimi-code": minor
---

Add per-session git worktrees to the web UI and the server API. Choose Worktree in the Environment selector when starting a session on a git project; `POST /api/v1/sessions` accepts an optional `worktree` request.
