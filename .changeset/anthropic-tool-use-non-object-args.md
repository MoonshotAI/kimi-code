---
"@moonshot-ai/core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Ensure Anthropic `tool_use.input` always lowers empty or non-object `toolCall.arguments` to `{}`.
