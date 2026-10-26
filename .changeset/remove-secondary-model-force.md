---
"@moonshot-ai/kimi-code": patch
---

Remove `[secondary_model] force`, which is now ignored with a warning: a lone `default_model` still pins every subagent to that model.
