---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kosong": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
---

Harden quota-exhausted detection and MCP schema compatibility: fail fast on Alibaba/DashScope billing 429s (arrearage/balance/quota) instead of retry-looping on dead token plans, and normalize stray `regex` JSON Schema keyword to `pattern` at MCP import/Kimi normalization to fix Meta Muse Spark strict validation errors.
