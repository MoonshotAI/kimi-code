---
"@moonshot-ai/kimi-code": patch
---

Fix OpenAI-compatible providers reporting the wrong model context window — use the value the provider advertises instead of a fixed 128K default.
