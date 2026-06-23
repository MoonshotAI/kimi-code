# OpenSpec for Kimi Code

An MCP plugin that lets Kimi Code interact with [OpenSpec](https://fission.ai/openspec) projects.

## Provided Tools

- `openspec_status` – Check whether the workspace is an OpenSpec project.
- `openspec_list_changes` – List all changes (proposals) under `openspec/changes/`.
- `openspec_list_specs` – List all specs under `openspec/specs/`.
- `openspec_read_change` – Read a file inside a change directory (`proposal.md`, `design.md`, `tasks.md`).
- `openspec_read_spec` – Read a spec file or list its contents.

## Usage

When a workspace contains an `openspec/config.yaml`, the plugin tools become available. Ask Kimi Code to:

- "List all OpenSpec changes"
- "Read the proposal for the auth-refactor change"
- "Show me the specs"

## Requirements

None beyond a standard Node.js runtime. The plugin reads files directly from disk.
