---
"@moonshot-ai/kimi-code": patch
---

Fix terminal scrollback being wiped after a Write tool call by capping the in-transcript preview as soon as args finalize (instead of waiting for the result).
