---
"@moonshot-ai/kimi-code": patch
---

Fix goal pursuit being interrupted when a goal turn reaches the per-turn step limit (`loop_control.max_steps_per_turn`); the limit now splits goal work into more continuation turns instead of pausing the goal.
