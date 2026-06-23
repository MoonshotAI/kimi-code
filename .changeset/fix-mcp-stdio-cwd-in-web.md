---
'@moonshot-ai/agent-core': patch
---

fix(mcp): default stdio server cwd to the session directory for user and project-local configs

When `kimi web` launches the background server daemon, the server process runs from `~/.kimi-code/server`. stdio MCP servers that did not explicitly set `cwd` therefore inherited that directory instead of the user's project directory, breaking workspace-relative storage (e.g. memory MCP servers).

`loadMcpServers` now assigns a sensible default `cwd` to every config source:
- user-global `~/.kimi-code/mcp.json` → session working directory
- repo-root `.mcp.json` → repo root (unchanged)
- project-local `.kimi-code/mcp.json` → session working directory

This makes stdio MCP behavior consistent between `kimi` and `kimi web`.
