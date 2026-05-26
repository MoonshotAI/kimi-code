# Changelog

This page documents the changes in each Kimi Code CLI release.

## 0.2.0

### Features

- Add a `/connect` command that configures a provider and model from a model catalog.
- The `/connect` provider and model pickers now support type-to-search filtering, and long lists are paginated. The `/model` picker is also paginated when many models are configured.
- Add `Ctrl-J` as an additional shortcut for inserting new lines in the TUI prompt.
- Add wire record migration handling during session replay.
- Migrate user skills from `~/.kimi/skills/` to `~/.kimi-code/skills/` during the first-launch migration; existing target skills are kept.
- Emit session resume hint as a structured meta message in stream-json output format.

### Bug Fixes

- Report the macOS product version in OAuth device information instead of the Darwin kernel version.
- Correct the `X-Msh-Platform` header value to `kimi_code_cli`.
- Clarify the prompt-mode error when no model is configured by pointing users to the login flow.
- Hide the empty current session from the sessions picker while keeping other empty sessions visible.
- Stop mentioning OAuth credentials in the migration UI — they are never migrated, so the previous "needs /login" notice misread as a failure. OAuth-only installs no longer trigger the migration screen.
- Surface API-provided error messages during feedback, usage, login, and model setup failures.
- Persist model selections from the terminal UI to the default configuration, and honor the configured default thinking state for new sessions.
- Retry compaction responses that do not contain a summary before updating conversation history.
- Avoid CPU spikes from large streamed tool arguments and coalesce high-frequency streaming UI updates.
- Resume sessions with a newer wire protocol version instead of failing. A warning is now shown in the TUI and records are replayed without migration.
- Warn tmux users when extended key settings may prevent modified Enter shortcuts from working.
- Let Kimi requests use the remaining context window for completion tokens by default while keeping explicit environment limits as hard caps.

### Refactors

- Flatten tool call data by inlining tool names and arguments at the top level, and limit legacy record migration so it only rewrites matching tool call payloads.
- Move wire metadata handling into the record layer and keep persistence backends limited to storage operations.

### Other

- When no models are configured, `/model` and the welcome panel now point users to `/login` (for Kimi) and `/connect` (for other providers).
