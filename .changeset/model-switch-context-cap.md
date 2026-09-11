---
"@moonshot-ai/kimi-code": patch
---

Update the footer's context limit when `/model` switches models before the first message; it previously kept the previous model's limit until the TUI was restarted.
