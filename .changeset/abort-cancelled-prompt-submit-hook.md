---
"@moonshot-ai/agent-core-v2": patch
---

Pass the starting turn's abort signal to prompt-submit hooks and use it for the UserPromptSubmit external hook, so cancelling the turn while the hook runs terminates the hook process and discards its result instead of reminding a block result into the next turn and emitting a hook result event.
