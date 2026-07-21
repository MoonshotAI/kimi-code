---
"@moonshot-ai/kimi-code": minor
---

Shorten plugin MCP tool names by dropping the redundant `plugin-` prefix and the server-name segment for single-server plugins (e.g. `mcp__plugin-foo-mcp_s__bar` becomes `mcp__foo-mcp__bar`). Existing per-tool permission approvals for plugin MCP tools will need to be re-granted after upgrading.
