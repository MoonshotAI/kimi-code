---
"@moonshot-ai/kimi-code": patch
---

Persist a picked thinking effort as the default unless it exceeds the model's default effort, so the top level (such as max) can now be saved when it is the model's default. Picks above the model's default, such as xhigh on Claude models whose default is high, now apply to the current session only instead of being saved.
