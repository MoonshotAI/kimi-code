---
"@moonshot-ai/kimi-code": minor
---

Add the `StepFinished` hook event: it fires after every agent step — once its tool calls complete, before the next model request — and the agent loop waits for it to finish. Configure it with `event = "StepFinished"` in `[[hooks]]`.
