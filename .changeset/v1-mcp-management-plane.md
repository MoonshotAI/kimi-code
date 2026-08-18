---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": minor
"kimi-code": patch
---

On the legacy engine, MCP server changes (install / enable / disable / remove / reload) now apply to open sessions immediately — no manual reconnect needed. Signing in to an MCP server with OAuth or resetting its credential now automatically refreshes the affected sessions, and a connection that fails mid-session for auth reasons is reported as needing sign-in instead of a generic failure.

`@moonshot-ai/kimi-code-sdk`: MCP servers are now managed through a unified registry that also covers plugin-declared servers. SDK callers can list, inspect, probe, add, reconnect, and authenticate MCP servers at runtime — including plugin servers — with effective config and probe-verified authorization state. Stored OAuth grants now record expiry and refresh proactively, concurrent logins for the same credential share one browser flow, and secret-bearing `env` / `headers` values are redacted to key lists in status responses.
