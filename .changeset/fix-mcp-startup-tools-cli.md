---
'@moonshot-ai/kimi-code': patch
---

Fix MCP tools discovered during session startup being unavailable for the whole session. Session creation and resume now wait for initial MCP server connections to settle, bounded by the per-server startup timeout.
