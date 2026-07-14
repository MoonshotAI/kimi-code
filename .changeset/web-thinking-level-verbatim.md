---
"@moonshot-ai/kimi-code": patch
---

web: Send the selected thinking level to the backend as-is instead of silently downgrading it, drop the hardcoded 'high' default so the model's own default applies when nothing is chosen, and pre-select the target model's default level when switching models — matching the CLI.
