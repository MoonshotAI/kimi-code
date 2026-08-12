---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Show project MCP launch targets in the workspace trust prompt, default to declining trust, and resolve fd and stty binaries to absolute paths so untrusted workspaces cannot plant bare-name executables before confirmation.

`@moonshot-ai/kimi-code-sdk` contract change: `WorkspaceTrustInfo.gatedMcpServers` now carries structured `WorkspaceTrustMcpServerInfo` records (`name`, `transport`, and `command`/`args`/`cwd` or `url`) instead of plain strings, so SDK consumers rendering a trust prompt can show the full launch target.
