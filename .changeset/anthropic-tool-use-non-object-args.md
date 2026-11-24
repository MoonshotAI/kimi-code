---
"@moonshot-ai/core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
"kimi-code-app": patch
"kimi-code": patch
---

Ensure Anthropic `tool_use.input` always lowers non-object or empty `toolCall.arguments` to `{}`.
