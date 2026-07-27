---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Sanitize MCP tool JSON Schemas for Moonshot's stricter validator: resolve local `$ref` (including circular), fill missing `type`, normalize tuple `items`, and map common `disabled` / `max_tokens` config aliases.
