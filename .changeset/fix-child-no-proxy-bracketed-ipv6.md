---
"@moonshot-ai/kimi-code": patch
---

Fix stdio MCP servers (Python httpx-based) crashing with `httpx.InvalidURL` when a proxy is configured. The bracketed `[::1]` loopback entry is no longer injected into child process `NO_PROXY`; only the bare `::1` is used, which all major HTTP client libraries parse correctly.
