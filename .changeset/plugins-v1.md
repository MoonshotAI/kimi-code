---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Introduce the Kimi Code plugin protocol rooted at `plugin.json`, with `.kimi-plugin/plugin.json` for multi-harness repositories such as Superpowers. Plugins can contribute skills, declarative `sessionStart.skill`, `skillInstructions`, display metadata, and opt-in `mcpServers`. Plugin changes are picked up by new sessions; `/plugins reload` refreshes plugin records and diagnostics but does not hot-reload the current session. Plugin MCP servers are parsed and shown at install time but only start after the user explicitly enables a server with `/plugins mcp enable` and starts a new session. Third-party command/tool runtimes, executable hooks, legacy `config_file`/`inject` adapters, `.codex-plugin/plugin.json` fallback loading, and hard-coded Superpowers behavior are not enabled by the plugin loader.
