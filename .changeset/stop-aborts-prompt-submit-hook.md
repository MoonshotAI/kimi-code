---
'@moonshot-ai/agent-core-v2': patch
---

Make a cancel without a target stop the prompt the user just sent when no turn is running yet: a prompt whose turn is still starting, one that waits for its turn, and a client prompt that is still being admitted are now cancelled instead of left to run. `UserPromptSubmit` hooks now receive the starting turn's abort signal, so cancelling stops a running hook.
