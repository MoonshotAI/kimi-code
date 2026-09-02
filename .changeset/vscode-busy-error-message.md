---
"kimi-code": patch
---

Stop reporting a busy chat session as "Internal error occurred." A prompt sent while a response is still being generated now surfaces as "A message is being sent. Please wait." (code `turn.agent_busy`) with the original detail attached, instead of the generic internal-error message that the plain `Error` was mapped to.
