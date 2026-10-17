---
"@moonshot-ai/kimi-code": minor
---

Prompts sent while the agent is working are now delivered together: when a turn ends with several prompts queued, the model receives all of them at once in a single turn instead of answering them one turn each in FIFO order.
