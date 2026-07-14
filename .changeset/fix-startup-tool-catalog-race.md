---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code-oauth": patch
---

Fix startup races that could leave sessions without their configured tools by serializing configuration writes and atomically replacing provider and model catalogs.
