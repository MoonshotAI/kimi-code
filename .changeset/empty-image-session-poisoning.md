---
"@moonshot-ai/kimi-code": patch
---

Fix pasted images intermittently failing to reach the model: a zero-byte image from a failed clipboard read poisoned the session, so every later image was dropped with an ambiguous placeholder and the model could hallucinate having seen it. Prompts carrying an empty image are now rejected with a clear error so you can re-paste before anything is sent, sessions already affected recover automatically, and the placeholder tells the model the attachment was removed and must not be guessed at.
