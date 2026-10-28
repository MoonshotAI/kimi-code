---
"@moonshot-ai/kimi-code": patch
---

Stop resending full-size images on every turn after the provider rejects them as too large or unsupported; later turns and compaction keep the reduced images until you switch models or the conversation history is rewritten.
