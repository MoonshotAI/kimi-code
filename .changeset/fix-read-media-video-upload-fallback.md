---
"@moonshot-ai/kimi-code": patch
---

Fix ReadMediaFile failing on videos when the model's provider has no usable file upload channel — the video now falls back to being sent inline.
