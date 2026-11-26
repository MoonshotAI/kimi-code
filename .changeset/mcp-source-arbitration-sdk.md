---
"@moonshot-ai/kimi-code-sdk": patch
---

Bundle the session-scoped MCP source management with per-source toggles, partial project disable overrides, and ref-counted shared connections across sessions in the same project, and keep unpersisted `addSessionMcpServer` and explicit-config `reconnectMcpServer` upserts scoped to their own session instead of leaking into sibling sessions of the same directory.
