---
"@moonshot-ai/kimi-code": patch
---

Fix conversations breaking after switching from a multimodal model to a text-only model. Media content blocks in history are now automatically stripped and retried when the text-only model rejects them.
