---
"@moonshot-ai/kimi-code": patch
---

web: Fix sending a bare skill slash command (e.g. /update-config) echoing the raw command text after the skill name (which was also sent to the model as arguments).
