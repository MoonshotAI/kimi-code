---
"@moonshot-ai/kimi-code": patch
---

Stop showing a spurious error banner when a goal turn reaches the per-turn step limit (`loop_control.max_steps_per_turn`) during autonomous goal pursuit; the limit is expected control flow there and still surfaces for ordinary turns.
