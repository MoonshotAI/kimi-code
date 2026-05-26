---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Always emit a paired tool result when a tool returns a malformed or missing result, preventing the next request from failing with a missing tool_call_id error.
