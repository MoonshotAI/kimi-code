---
"@moonshot-ai/kimi-code": patch
---

Fix pasted images intermittently failing to reach the model: a zero-byte image from a failed clipboard read poisoned the session, so every later image was dropped with an ambiguous placeholder and the model could hallucinate having seen it. Empty images are now replaced by a clear notice at ingestion and at send time (already-affected sessions recover automatically), and the placeholder tells the model the attachment was removed and must not be guessed at.
web: Show an error chip instead of uploading a zero-byte attachment (e.g. from a failed clipboard image read).
