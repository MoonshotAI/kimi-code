---
"@moonshot-ai/kimi-web": patch
"@moonshot-ai/server": patch
"@moonshot-ai/services": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/protocol": patch
"@moonshot-ai/kimi-code": patch
---

Persist session archive state on the server, filter archived sessions from the default session list, and add an optional `include_archive` parameter to include them. Each listed session now exposes an `archived` flag.
