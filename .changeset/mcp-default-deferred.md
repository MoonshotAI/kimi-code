---
"@moonshot-ai/kimi-code": patch
---

Add the [mcp] default_deferred config key: when the experimental tool-select flag is on, set default_deferred = true in config.toml to load every MCP server's tools on demand by default; a server can opt out with deferred: false.
