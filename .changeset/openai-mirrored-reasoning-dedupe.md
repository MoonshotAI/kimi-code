---
"@moonshot-ai/kimi-code": patch
---

Fix duplicated thinking text with OpenAI-compatible servers that send the same reasoning in both `reasoning_content` and `reasoning`, and make a configured `reasoning_key` actually limit which field is read.
