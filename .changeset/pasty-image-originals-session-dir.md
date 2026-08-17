---
"@moonshot-ai/kimi-code": patch
---

Save the uncompressed original of a pasted image into the session's own media directory when the prompt is sent, instead of a shared temp path captured before the session existed, so the readback path given to the model stays valid for the session's lifetime.
