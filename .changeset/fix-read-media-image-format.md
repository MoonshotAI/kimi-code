---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Detect the real image format from file contents when reading media, so a mismatched filename extension no longer produces a data URL the model API rejects.
