---
"@moonshot-ai/kimi-code-sdk": minor
---

Unify the MCP management surface behind a source-tagged registry: `listMcpServers` now covers plugin-declared servers with `source` / `origin` / `mutable` markers, and adds `getMcpServer`, `testMcpServerConfig`, runtime `addMcpServer` with an optional persist flag, and an `oauth-expired` auth state; `reconnectMcpServer` re-resolves the current config unless given a replacement. Also adds the app-level `inspectAppMcpServers` with locator-addressed OAuth RPCs, and redacts secret-bearing `env` / `headers` values in status entries.
