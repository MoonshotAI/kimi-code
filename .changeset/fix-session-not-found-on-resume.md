---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Fix stale closed session handling during resume to prevent `[session.not_found]` errors after initialization failures.

When a session was closed while initialization was still running (for example, because an MCP server failed to start), the session object could remain in memory while the persisted directory still existed. Resuming that session later then failed with `[session.not_found]`. The session map now drops stale closed sessions during resume, and the TUI aborts cleanly if the session disappears while applying startup modes.
