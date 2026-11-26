---
"@moonshot-ai/agent-core-v2": minor
---

Add Git worktree creation, inspection, and removal, along with live session occupancy tracking, project-scoped session listing, and missing-directory turn reminders. Setup script execution prefers the new worktree's `.kimi-code/worktree-setup.sh` (falling back to the source checkout) and runs it with the local host shell.
