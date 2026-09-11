---
"@moonshot-ai/kimi-code": minor
---

Add `KIMI_CODE_PERMISSION_MODE_REMINDER` environment variable: set it to `0` (or `false`/`no`/`off`) to disable the auto (AFK) permission-mode enter/exit reminders injected into the model context. Useful for unattended evaluation harnesses that run with auto permission mode but should not bias the model with the auto-mode instructions.
