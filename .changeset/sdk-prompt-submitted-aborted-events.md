---
'@moonshot-ai/kimi-code-sdk': minor
---

Forward `prompt.submitted` and `prompt.aborted` to SDK session event listeners. Hosts learn when the engine accepts a prompt, so a cancel requested while the prompt was still on its way can be sent again, and can settle a prompt that was cancelled before its turn started. Both events were already part of the `Event` union.
