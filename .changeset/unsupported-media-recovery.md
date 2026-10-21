---
"@moonshot-ai/kimi-code": patch
---

Fix sessions permanently failing with HTTP 400 when the provider rejects base64 video or audio inside tool results; the request now retries with the media downgraded to placeholder text.
