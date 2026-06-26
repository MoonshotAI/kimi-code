---
"@moonshot-ai/kimi-code": patch
---

feat(plugins): add OpenSpec MCP plugin

Introduces `kimi-openspec`, an official MCP plugin that lets Kimi Code interact with OpenSpec projects.

- `openspec_status` – Check whether the workspace is an OpenSpec project.
- `openspec_list_changes` – List all changes under `openspec/changes/`.
- `openspec_list_specs` – List all specs under `openspec/specs/`.
- `openspec_read_change` – Read a file inside a change directory.
- `openspec_read_spec` – Read a spec file or list its contents.

Plugin reads files directly from disk; no external dependencies required.
