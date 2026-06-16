---
"@moonshot-ai/kimi-code": minor
---

When Esc or Ctrl-C interrupts a turn before the model has produced any output, the prompt is now automatically withdrawn from the transcript and its text is restored to the editor. If the model has already streamed text or issued a tool call, the interrupt only cancels the stream (unchanged behavior).
