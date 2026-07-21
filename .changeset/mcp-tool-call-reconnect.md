---
"@moonshot-ai/kimi-code": patch
---

Reconnect a dropped MCP server connection automatically when one of its tools is called, and retry the call once. A server whose connection dies between turns no longer loses its tools from the tool list — they stay available and the next call heals the connection instead of failing with "tool not found".
