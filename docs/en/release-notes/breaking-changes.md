# Breaking changes

## Unreleased

**Affected**: The dedicated `Read`, `Grep`, and `Glob` tools are removed from all built-in agent profiles and subagent profiles. File searches and ordinary text reads now use `Bash`; `ReadMediaFile` reads UTF text files and session attachments. `TaskOutput` accepts `offset` and `limit` for direct byte-range access to persisted task output. Existing `[read]` settings no longer affect file reads. Side questions only allow `ReadMediaFile`; the `plan` subagent uses read-only Bash commands. Bash rejects literal sensitive-file operands for common read and search commands; dynamic shell commands still follow the configured permission policy and do not receive the former tools' automatic sensitive-file filtering.

**Migration**: Use `rg --files` to locate files, `rg` to search contents, and bounded commands such as `sed -n '1,240p' file` to read text. Use `ReadMediaFile` for images, videos, and text attachments, and use `TaskOutput` with `next_offset` to page task logs. Remove obsolete `[read]` settings. Update agent-file tool allowlists and permission rules that reference the removed tools.
