---
"@moonshot-ai/kimi-code": minor
---

Detect stalled turns and force text-only recovery. When the agent emits consecutive tool calls that produce no external progress, the harness clears the available tool list and asks the model to respond in text instead of continuing the loop.
