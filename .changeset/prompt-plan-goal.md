---
"@moonshot-ai/kimi-code": patch
---

Prompts sent to the main agent now apply `plan_mode: true` (which also leaves Tower mode) and `goal_objective` (which also leaves Plan mode) when the prompt starts; `plan_mode: false` is still ignored.
