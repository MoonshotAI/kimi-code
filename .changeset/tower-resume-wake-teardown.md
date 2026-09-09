---
"@moonshot-ai/kimi-code": patch
---

In tower mode, worker resumes run in the background instead of blocking the tower, worker messages notify the tower immediately, teardown skips already-removed worktrees, and branch-name collisions are rejected at planning time.
