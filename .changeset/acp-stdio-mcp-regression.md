---
"@moonshot-ai/kimi-code": patch
---

ACP: fix stdio MCP servers being rejected in session/new, session/load, and session/resume with "does not declare a runtime identity" since v0.37.0, which broke ACP clients (e.g. Zed) that forward stdio MCP servers. Also fix session/load failing with "registered twice in one transaction" when a session is closed and loaded again in the same process.
