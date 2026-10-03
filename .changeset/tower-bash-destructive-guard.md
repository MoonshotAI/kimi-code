---
"@moonshot-ai/kimi-code": minor
---

Tower mode now refuses Bash commands that would destroy the tower workspace — a forceful `git clean` covering the main checkout, `git reset --hard` in the main checkout, or `rm` on tower protocol paths — and tells the agent to run them inside a worktree instead.
