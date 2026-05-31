---
"@moonshot-ai/kimi-code": minor
---

Add a `/effort` slash command (alias `/thinking`) to adjust the model's thinking effort at runtime. `/effort <level>` sets one of `off`, `low`, `medium`, `high`, `xhigh`, `max` directly; `/effort` with no argument opens a picker highlighting the current level. Invalid levels are rejected with the list of valid values.
