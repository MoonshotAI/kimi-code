---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

`/plugins reload` now hot-applies plugin changes to the current session — no `/new` required. Newly installed or enabled plugin skills load immediately (the main agent's skill list and `Skill` tool are refreshed) and newly enabled plugin MCP servers are connected. Disable, remove, update, and `sessionStart` changes are not torn down in a running session; reload reports when a new session is still needed to fully apply them.

Adds `PluginManager.runtimeSnapshot()` and `Session.applyPluginRuntimeSnapshot()` in `agent-core`; the SDK's `reloadPlugins()` now returns the applied result (`PluginReloadResult` / `PluginRuntimeApplyResult`).
