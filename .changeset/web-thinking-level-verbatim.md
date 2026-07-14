---
"@moonshot-ai/kimi-code": patch
---

web: Align thinking-level handling with the CLI: submit the selected level verbatim instead of silently downgrading it, pin the model's catalog default when nothing was chosen, pre-select the target model's default on model switches, and persist explicit picks as the daemon-wide default so new sessions inherit them.
