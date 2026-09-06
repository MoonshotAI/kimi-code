---
"@moonshot-ai/kosong": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Skip empty OpenAI-compatible `reasoning_content` stream values so they are not journaled as no-op think parts.
