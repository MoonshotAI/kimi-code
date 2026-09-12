---
"@moonshot-ai/kimi-code": patch
---

Fix a crash that killed the process when a retried LLM request had streamed a partial tool call before disconnecting.
