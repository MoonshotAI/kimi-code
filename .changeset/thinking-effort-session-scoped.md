---
"@moonshot-ai/kimi-code": minor
---

Thinking effort picks now persist only below the model's highest declared level — the top tier is session-only, and a previously persisted `max` is migrated to `high` once. The web UI restores each session's own level when switching sessions and seeds new sessions from the per-model pick.
