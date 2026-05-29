# Changelog

This page documents the changes in each Kimi Code CLI release.

## 0.5.0

### Features

- Add scheduled tasks:

  You can now ask the agent to remind you at a specific time, run a task on a recurring cron schedule (for example, check a deploy every 5 minutes or run a daily report every weekday at 9am), or come back on its own in a few minutes to continue what it was doing.

  Schedules use the standard 5-field cron syntax.

- Add `/auto` slash command and `--auto` CLI flag for auto permission mode.
- Show file content and diff in Write and Edit approval prompts, and open them in a dedicated full-screen viewer on ctrl+e instead of expanding inline.

### Bug Fixes

- Fix compaction to handle edge cases where no messages are compactable and improve retry logic.
- Fix official datasource tools to preserve complete responses and write returned result files.
- Fix migration mapping the legacy `default_yolo` key to the dead `yolo` field instead of `default_permission_mode`.

### Polish

- Add a clickable changelog link to the update prompt.
- Show the full Bash command when expanding a Bash tool card with `ctrl+o`. The header still truncates long commands at 60 chars, but the expanded view now reveals the complete multi-line command above the output.
- Shorten the session title written to the terminal window/tab from 80 to 32 characters so long first messages and pasted content no longer stretch the tab bar past readable width.
- Cap the inline todo panel at five rows and show a `+N more` indicator so long task lists no longer fill the screen.
- Clarify plugin manager keyboard shortcuts and show plugin state changes inline.
- Report discovered plugin skills in plugin manager summaries.
- Offload large base64 media payloads from `wire.jsonl` into external blob files to reduce wire size and memory pressure during session replay. Includes an in-memory read-through cache on `BlobStore` so repeated rehydration avoids redundant disk reads.
- Wrap long question, body, and option text in the AskUserQuestion dialog instead of truncating with an ellipsis. The question prompt, body description, option label, option description, and submit-tab review entries now flow onto multiple lines with a hanging indent.

### Refactors

- Refactor TUI code structure.

## 0.4.0

### Features

- Add user-global plugin installation, interactive plugin management, plugin-provided skills, and plugin-owned MCP servers.
- Expand folded paste markers on second paste.
- Rework tool permissions: reads outside cwd no longer prompt, session approvals match the exact call, and path-based rules are case-insensitive.
- Add `/export-debug-zip` slash command to export the current session as a debug ZIP archive directly from the TUI.
- Add `/export-md` slash command to export the current session as a Markdown file.

### Bug Fixes

- Prevent the TUI from crashing when pull request lookup fails during startup.
- Fix thinking spinner leaking past turn end when an empty thinking delta creates an orphaned thinking component.
- Show the original session resume command after forking a session.
- Restrict plugin zip installs to manifests at the archive root or a single wrapper directory.
- Route session-tagged log entries exclusively to the session sink instead of duplicating them to the global sink. Consistently omit stable main-agent context keys from all session log lines that carry `agentId=main`.

### Refactors

- Refactor TUI resume replay logic.
- Use one retry classification for transient LLM failures across regular turns and compaction.

### Other

- Enhance `kimi export` to include more diagnostic information in the manifest.

## 0.3.0

### Features

- `/logout` now opens a picker so you can choose which provider to log out of, instead of always logging out the one tied to the current model. The current provider is highlighted by default, so pressing Enter matches the previous behavior. The command is also available as `/disconnect`.
- The `openai` provider now works out of the box for OpenAI-compatible reasoner models: it auto-detects thinking fields in responses (`reasoning_content` / `reasoning_details` / `reasoning`) and auto-injects `reasoning_effort` when history contains prior thinking. DeepSeek, Qwen, One API and other gateway-fronted services no longer need a hand-set `reasoning_key`, which remains available as an explicit override for non-standard gateways.

### Bug Fixes

- Prevent running the `/model` and `/sessions` slash commands while streaming or compacting context.
- Preserve catalog-declared interleaved reasoning fields for OpenAI-compatible models configured through `/connect`.
- Fix API key input dialog showing a masked dot in empty state.
- Fix user skills in `~/.agents/` not being loaded.
- Restore real-time token display for running subagents in the TUI.
- Hide the todo panel on resume when all todos are already completed.
- Always emit a paired tool result when a tool returns a malformed or missing result, preventing the next request from failing with a missing tool_call_id error.
- Fix Plan mode session resets so new sessions no longer fail after plan review rejection and continue receiving events after setup errors.
- Exit promptly when the controlling terminal goes away. The TUI now handles `SIGHUP` / `SIGTERM` and stdout/stderr `EIO` / `EPIPE` / `ENOTCONN` errors, preventing leftover `kimi` processes that pin a CPU core after the parent shell or multiplexer dies unexpectedly.
- Avoid overly small local completion caps that can truncate reasoning before summaries are produced.

### Refactors

- Make `AgentRecords` hold the `Agent` instance directly and inline the restore dispatch logic.

### Other

- Improve the Write tool UX.

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
