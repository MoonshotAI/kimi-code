---
"@moonshot-ai/kimi-code": patch
---

Fix sessions hanging on the second approval prompt and tool call results being dropped or mixed up in history when using a self-hosted OpenAI-compatible endpoint that renumbers tool call ids on every response.
