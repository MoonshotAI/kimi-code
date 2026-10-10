---
"@moonshot-ai/kimi-code": patch
---

Surface SessionStart hook stdout instead of discarding it: successful hook output is appended to the main agent's conversation context and emitted as a hook.result event, so it reaches both the model and the transcript.
