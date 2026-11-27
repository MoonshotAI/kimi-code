---
"@moonshot-ai/kimi-code-sdk": minor
---

Add the `turn.step.stream_reset` event to the public event type so clients can discard what a retried model request had already streamed for that step. Clients already received this event at runtime; exhaustive switches over session events now need a case for it.
