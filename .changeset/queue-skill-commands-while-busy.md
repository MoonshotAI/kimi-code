---
"@moonshot-ai/kimi-code": patch
---

Queue slash skill commands entered while the agent is busy instead of rejecting them with "Cannot /<cmd> while streaming" — they now behave exactly like normal input: queued visibly by default, and Ctrl-S steers them into the running turn as real skill activations.
