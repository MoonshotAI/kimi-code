---
outline: 2
---

# Changelog

This page documents the changes in each Kimi Code CLI release.

## 0.19.0 (2026-06-22)

### Features

- Added the ability to add extra workspace directories:
  - Use the `/add-dir <path>` command to add extra working directories to the current session, or remember them for the project.
  - Use `kimi --add-dir <path>` to add them on startup.
  - Project-level local config is now managed in `.kimi-code/local.toml`; we recommend adding it to your `.gitignore`.
- Allow long-running foreground commands and subagents to be moved into background tasks with `Ctrl+B`, and inspect them via the `/tasks` panel.

### Bug Fixes

- Surface provider safety-policy blocks instead of silently treating them as completed turns, and prevent the context token count from dropping to zero after a filtered response.
- Fix provider requests failing when restored conversation history contains empty text content blocks.
- Detect the real image format from file contents when reading media, so a mismatched filename extension no longer produces a data URL the model API rejects.
- Fix commands flashing an empty console window on Windows.
- Stop showing unread dots on cancelled or failed sessions in the web sidebar.

### Polish

- Speed up session snapshot loading with a direct disk reader and a request timeout safeguard, keeping the previous path as a legacy fallback.
- Show longer branch names in the web chat header and expose the full name on hover.
- Keep the web page title fixed instead of changing with the session or workspace name.
- Polish file mention UX.

### Refactors

- Unify image format detection when sniffing fails.
- Consolidate web client localStorage access and decouple appearance/notification state into dedicated modules.

## 0.18.0 (2026-06-18)

### Features

- Add session filtering to the web sidebar, filtering by title and the last user prompt.
- Add scroll-up lazy loading for older messages in the web chat session view.
- Add an environment variable to cap AgentSwarm concurrency during the initial ramp, so large swarms do not trip provider rate limits as easily.

### Bug Fixes

- Fix the web app only loading the 20 most recent sessions.
- Fix web slash skill selection sending immediately and allow slash search to match skill names by substring.
- Fix the highlighted web slash command not staying visible while navigating a long slash menu.
- Fix incorrect display after archiving the last session.
- Fix the web login slash command description to match the browser authorization flow.

### Polish

- Redesign the web OAuth login dialog so the order of steps is unambiguous.
- Show the current version in web settings.
- Allow long web slash command names and descriptions to wrap without overflowing the slash menu.
- Add `/reload` suggestion in plugin-change hints.

## 0.17.1 (2026-06-17)

### Bug Fixes

- Fix the `kimi web` command failing to start in the background.
- Stop the background local server from locking the directory it was started in.
- Prevent the web login dialog from closing when clicking the backdrop.

### Polish

- Group the default model dropdown in web settings by provider.

## 0.17.0 (2026-06-17)

### Features

- Add Kimi Code Web mode, which you can start with `kimi web` or `/web` in the CLI, and continue sessions in a browser chat interface.

### Bug Fixes

- Show the underlying connection error when OAuth token refresh fails after internal retries, instead of prompting for login. Token refresh failures are no longer re-retried at the agent loop level.
- Restore the turn counter from persisted loop events on resume so post-resume turns no longer reuse turn ids that already appear in history.

### Polish

- Skip debug TPS when the output stream is too short to measure reliably.

## 0.16.0 (2026-06-16)

### Features

- Add a built-in `kimi vis` command that launches the session visualizer in your browser, pointed at your local sessions. Supports `--port`/`--host`, `--no-open`, and `kimi vis <sessionId>` deep-links.

### Bug Fixes

- Stop Anthropic-compatible providers from reading ambient Anthropic shell credentials and custom headers.
- Fix repeated compaction handling when context remains over the blocking threshold.
- Prevent session shutdown from resuming the agent when stopping background tasks.
- Project session replay ranges over rendered replay records instead of raw persisted records.
- Close wrapped output streams when buffered readers are destroyed.

### Polish

- Reduce the maximum height of the `/btw` side panel from half to one-third of the terminal.
- Polish queue pane styling.
- Add configurable banner display frequencies with local display state.

### Refactors

- Remove redundant LLM request logging context plumbing.

## 0.15.0 (2026-06-15)

### Features

- Add an all-sessions picker view with name search, paginated browsing, and clipboard-ready resume commands for sessions in other working directories.
- Add support for legacy SSE MCP servers alongside stdio and streamable HTTP transports.

### Bug Fixes

- Recover resumed sessions when an interrupted tool call result was not recorded.
- Stop writing resume version markers into persisted agent metadata.
- Do not carry obsolete legacy loop, background, plan, yolo, or unknown experimental flags into migrated config files.
- Repair mismatched JSON Schema types emitted by Xcode 26.5 MCP server for Moonshot compatibility.

### Polish

- Keep TUI components within narrow terminal widths by wrapping, compacting, or truncating lines that could exceed the render width.
- Prompt the CLI to show one brief same-language status sentence before non-trivial tool calls.
- Extend the same-language rule to the model's reasoning, so thinking follows the user's language while keeping code and technical terms in their original form.
- Read media files using header-detected types before falling back to media extensions.
- Prioritize clearing draft editor text before Ctrl-C cancels an active stream.
- Collapse hidden directories in the workspace prompt and explain how to inspect them.
- Include the skill's directory on the loaded-skill context block so the agent can locate a skill's bundled resources (scripts, templates) after it is invoked.
- Show the all-sessions toggle hint when the current working directory has no sessions.
- Clarify that compaction summaries must be emitted in the final answer.
- Clarify AGENTS.md prompt guidance and mark truncated instruction files.

### Refactors

- Resolve model capabilities through a static lookup instead of instantiating a temporary provider.
- Decouple agent skill access from session-specific registry implementations.
- Optimize the npm packaging system.

## 0.14.3 (2026-06-14)

### Polish

- Refresh provider model metadata before opening the model picker.

## 0.14.2 (2026-06-12)

### Bug Fixes

- Fix endless desktop notifications in iTerm2 by only sending terminal progress sequences to terminals that support them.
- Show completed and cancelled compaction records correctly when resuming a session.
- Drop invalid config.toml sections with a warning instead of failing to start.

### Polish

- Stream foreground Bash stdout and stderr while commands are still running.
- Allow `--auto`, `--yolo`, and `--plan` to be combined with `--session` or `--continue` by applying the requested mode to the resumed session.
- Qualify sub-skill names with their parent prefix and expose sub-skills as dotted slash commands in the TUI.
- Sync custom registry provider additions, removals, and rotated registry keys during startup refresh.

## 0.14.1 (2026-06-12)

### Bug Fixes

- Cancel active turns during session shutdown so foreground shell commands do not outlive prompt-mode exits.
- Stop background tasks by default when sessions close.
- Prevent overlapping interactive agent requests from using the wrong active agent.
- Fix premature stream close errors when shell processes time out or are killed.
- Degrade unsupported audio/video to placeholder text and reattach tool result media instead of silently dropping them.
- Send OpenAI Responses system prompts as request instructions.
- Propagate configured execution environment overrides across spawned processes.
- Fix ACP file reads and edits for Windows workspaces opened through IDE clients.
- Require AgentSwarm tool calls to run alone in a model response.

### Polish

- Add runtime support for dynamic MCP server updates, reference skills, replay timestamps, and Node file uploads.
- Add a YOLO choice when starting swarm tasks from Manual mode.
- Polish builtin skills.
- Find slash commands by their aliases in autocomplete — typing `/clear` now suggests `new (clear)`.
- Wrap long command and skill descriptions in the autocomplete menu onto a second line instead of cutting them off.
- Display a tips banner below the welcome panel on startup.

## 0.14.0 (2026-06-10)

### Features

- Add an `Interrupt` hook event that fires when the user interrupts a turn (e.g. pressing Esc), letting hooks observe the turn stopping instead of getting stuck on a working state.

### Bug Fixes

- Preserve image outputs from tools when using OpenAI-compatible chat completions.

## 0.13.1 (2026-06-10)

### Bug Fixes

- Prevent forking sessions during active turns and consolidate wire protocol definitions into a shared internal package.
- Fix Kimi Datasource to use the matching OAuth credentials and service endpoint for the active Kimi Code environment.
- Fix goal marker text overflowing terminal width.

### Polish

- Add Claude Fable 5 support to the Anthropic provider.
- Add an interactive undo selector and clearer undo-limit messages.
- YOLO mode no longer asks before writing or editing files outside the working directory.
- Clarify active skill prompts so loaded skills are no longer represented as system reminders.
- Tighten file tool guidance to route incremental edits through Edit.

## 0.13.0 (2026-06-10)

### Features

- Add custom color themes. Define your own palette as a JSON file in `~/.kimi-code/themes/`, or generate one with the built-in `/custom-theme` skill command.
- Add `/import-from-cc-codex` to import selected Claude Code and Codex instructions, Skills, and MCP settings.
- Show available plugin updates in the marketplace.

### Bug Fixes

- Fix Windows builds and development launches that could fail when package binaries resolve to command shims.
- Fix device login to keep the URL and code visible when the browser cannot be opened.

### Polish

- Clarify grouped subagent progress with active status breakdowns and elapsed time.
- Truncate queued message display to a single line with ellipsis when it exceeds terminal width.

## 0.12.1 (2026-06-09)

### Bug Fixes

- Allow obsolete experimental config entries to remain without blocking startup.
- Pass through xhigh reasoning effort for OpenAI-compatible chat completions requests.

## 0.12.0 (2026-06-09)

### Features

- Add the `/swarm` command for running agent swarms with live progress and rate-limit-aware retries.
- Make goals, background questions, and sub-skill discovery available without experimental opt-ins.
- Honor the standard `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` environment variables, including SOCKS proxies, for all outbound traffic.
- Support Homebrew installations.
- Enable micro compaction by default. Disable via `/experiments`.

### Bug Fixes

- Fix ACP slash skill routing, bootstrap context reads, file and permission edge cases, subagent event handling, and stale-file edit messaging.
- Fix goal resume behavior by restoring goal state from agent records.
- Fix thinking text and tool output display for subagents.
- Fix session workdir mismatch on Windows caused by inconsistent path separators.
- Fix the `/mcp` status panel border being broken by multi-line MCP server errors, which are now folded onto a single row.
- Detect Git Bash installed through Scoop and other Git shims on Windows.
- Show the underlying error when migration fails.
- Allow the startup session picker to exit with repeated Ctrl-C or Ctrl-D.

### Polish

- Remove the per-turn auto-compaction limit so long conversations can keep compacting instead of failing early.
- Improve goal mode outcome handling with follow-up messages, safer error pauses, and clearer TUI transcript display.
- Show full plan cards directly and remove the Plan card keyboard shortcut.
- Wrap long single-line shell commands in approval prompts so the full command remains visible.
- Rework file reference completion in the TUI.
- Load Kimi-specific user Skills and global agent instructions from `KIMI_CODE_HOME` when it is set.

## 0.11.0 (2026-06-05)

### Features

- Add experimental sub-skill discovery gated by the `KIMI_CODE_EXPERIMENTAL_SUB_SKILL` environment variable. Ships the `sub-skill` builtin bundle (`sub-skill.review`, `sub-skill.consolidate`) for inventorying and consolidating skills into hierarchical groups.
- Add the following environment variables:

  - `KIMI_MODEL_TEMPERATURE`, `KIMI_MODEL_TOP_P` — sampling parameters applied globally to any `kimi` provider (not tied to `KIMI_MODEL_NAME`).
  - `KIMI_MODEL_THINKING_KEEP` — Moonshot preserved-thinking passthrough (`thinking.keep`), injected only while Thinking is on.
  - `KIMI_CODE_NO_AUTO_UPDATE` (legacy alias `KIMI_CLI_NO_AUTO_UPDATE`) — fully disables the update preflight (no check, background install, or prompt).
- Show built-in skills as direct slash commands and group them ahead of external skill commands.

### Bug Fixes

- Fix slash command autocomplete so goal text can be submitted when the cursor is before existing text.
- Fix queued goals so failed promotion attempts do not lose or duplicate queued work.
- Fix upcoming-goal queue handling while editing or pasting queued goals.
- Ask before starting goals in YOLO mode so users can switch to Auto for unattended work.
- Show concise provider filtering errors when responses are blocked before visible output.
- Show "unknown command" instead of "too many arguments" when an invalid subcommand is entered.
- Clamp OpenAI Chat Completions `xhigh` and `max` thinking effort to `high` unless the model supports `xhigh` on `v1/chat/completions`.
- Preserve thinking effort when compacting long conversations.
- Refresh provider model metadata when capabilities change without model ID changes.

### Polish

- Show the upcoming-goal confirmation with the same accent treatment as goal lifecycle messages.
- Start upcoming goals immediately when there is no active goal to wait for.
  Support multiline edits when managing upcoming goals.
- Use a fixed 30-minute timeout for subagents and show concise resume instructions when they time out.
- Highlight goal queue subcommands while typing slash commands.

## 0.10.1 (2026-06-05)

### Bug Fixes

- Fix a crash when starting a goal in the TUI.

## 0.10.0 (2026-06-04)

### Features

- Users now can prepare several goals for the agent to work on sequentially. The agent will pick up the next goal from the queue once the current goal is completed. Use `/goal next <objective>` to queue a goal and `/goal next manage` to review and change the queue interactively.
- Add the built-in `update-config` skill — you can now have Kimi edit its own config files.
- Add persistent experimental feature toggles and a TUI panel that applies confirmed changes by reloading the current session.
- Add `/reload` to reload the current session and apply updated config files, plus `/reload-tui` to reload only TUI preferences.
- Add a doctor command for validating Kimi Code configuration files.

### Bug Fixes

- Normalize malformed Responses stream rate limit errors as provider rate limit failures.
- Keep managed OAuth credentials scoped to their configured authentication and API endpoints.
- Stop carrying active and queued goals into forked sessions.
- Fail early when Git Bash is missing on Windows before starting CLI sessions.
- Refresh the update target before showing foreground update prompts so the displayed version matches the install.
- Point session error diagnostics to the `/export-debug-zip` command.
- Set terminal tab titles without renaming the running process.

### Polish

- Start automatic background updates as soon as startup's fresh update check finds a newer version.
- Set the CLI process title to kimi-code during startup.
- Lowercase the stale file content message in edit tool errors.

### Refactors

- Ensure Nix-packaged CLI builds can find ripgrep and fd.

### Other

- Document the Git Bash prerequisite for Windows installs.

## 0.9.0 (2026-06-03)

### Features

- Add the `kimi acp` subcommand: kimi-code now speaks [Agent Client Protocol 0.23](https://agentclientprotocol.com/) over stdio so IDEs (Zed, JetBrains AI Chat, custom clients) can drive sessions directly — coverage matrix, Zed configuration and breaking pre-release notes are in [kimi acp Subcommand Page](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html).
- Add `/btw` for side-channel conversations without steering the active main turn, and allow `/btw` to open the side-channel panel before entering a question.

### Bug Fixes

- Fix external editor (Ctrl+G) on Windows by removing `/bin/sh` dependency and using platform-aware shell quoting for temp file paths.
- Use the OpenAI completion token field required by newer Chat Completions models.
- Use configured model output limits for completion token caps.
- Fix goal budget tool schemas for OpenAI-compatible providers.
- Resume saved subagents lazily when they are accessed.

### Polish

- Unify the interaction and visuals across TUI dialogs and selectors.
- Log enabled experimental flags at startup.

### Refactors

- Allow SDK runtime creation to use a separate RPC client while preserving local CLI startup.

## 0.8.0 (2026-06-02)

### Features

- Add experimental goal mode for longer tasks that need more than one turn. Turn it on with `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1` before you start Kimi.

  Use `/goal <objective>` in the TUI when you want Kimi to keep working on one task across turns. For example:

  ```text
  /goal Fix the failing checkout test
  ```

  Kimi shows the goal in the TUI and keeps progress visible while it works. Use `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`, and `/goal replace <objective>` to manage the goal. This feature is still experimental. Try it and tell us what would make it more useful.
- Add `kimi provider` CLI subcommand with `add`, `remove`, `list`, and `catalog list` / `catalog add` actions, so providers from a custom registry (api.json) or the public models.dev catalog can be imported and managed without launching the TUI.
- Add background structured questions so agents can continue while waiting for user answers.
- Add background automatic upgrades, which can be disabled in tui.toml.
- Add `/undo` slash command to withdraw the last prompt from conversation history, and keep replay records in sync when a prompt is undone.
- Add a `kimi upgrade` command for manually checking and upgrade Kimi Code CLI.
- Add approval lifecycle hook events for observing pending and completed permission prompts.
- Allow subagents to use custom tools registered on their parent agent.
- Allow glob searches to target explicit absolute paths outside the workspace.

### Bug Fixes

- Fix cross-provider replay failures from incompatible tool call IDs and unsigned Claude thinking history.
- Fix custom registry provider handling during re-import. Prevent loss of multi-provider entries and remove stale providers along with their model aliases and default model references.
- Fix tool output preview rendering: trim trailing empty lines, append ellipsis to multi-line Bash command headers, and truncate long single-line output by visual wrapped lines instead of raw newline count.
- Fix slash-activated skills not being recognized by the model due to missing system reminder wrapper.
- Fix a crash in the `/sessions` picker on very narrow terminals by clamping every rendered line to the terminal width.
- Normalize glob patterns before brace expansion to prevent incorrect path matching.
- Prevent modified keyboard release sequences from appearing after exiting the CLI.
- Fix Git Bash path detection on Windows by also searching `usr\bin\bash.exe` locations, which is where bash lives in many Git for Windows installations where `bin\bash.exe` does not exist.

### Polish

- Show MCP server summary in the welcome panel and add configuration hints in the /mcp command output.
- Point users to `/provider` instead of the removed `/connect` command in the welcome screen and the no-models-configured hint.
- Append the current todo list as markdown to compaction summaries before writing them to history.
- Show the full model name in the footer status bar instead of truncating the provider prefix.
- Remind the model to refresh TodoList during long-running tasks and strengthen TodoList progress-tracking guidance.
- Replace chalk named color with theme-aware hex in session-directory warning.

### Refactors

- Consolidate background task management under the agent background runtime.

## 0.7.0 (2026-06-02)

### Features

- Add `/provider` command for managing AI providers, support custom registry imports, and introduce a tabbed model selector. It replaces the deprecated `/connect` command — use `/provider` instead.
- Render scheduled reminders distinctly in the TUI, expose cron fired events to SDK clients, and report cron fire times with local timezone offsets.
- Add `KIMI_MODEL_ADAPTIVE_THINKING` (and a matching `adaptive_thinking` model-alias field) to force adaptive thinking (`thinking: { type: 'adaptive' }`) on or off, overriding the Anthropic model-name version inference. This lets custom-named compatible endpoints that back an adaptive-capable model opt in even when the model name does not encode a parseable Claude version.

### Bug Fixes

- Report truncated compaction summaries clearly and apply valid completion token budgets across supported providers.
- Fix glob pattern backslash escaping and include match count in truncation messages.

### Polish

- Clarify Kimi Platform API key login labels and prompt details.
- Polish a small TUI visual interaction.

## 0.6.0 (2026-05-29)

### Features

- Add a `KIMI_MODEL_*` environment-variable channel that lets you run Kimi Code against a specific model (provider type, base URL, API key, context size, capabilities, and thinking settings) without editing `config.toml`.
- Install plugins directly from GitHub repository URLs, and surface each install's origin and trust level (kimi-official, curated, third-party) in the plugin manager.

### Bug Fixes

- Show the real terminal status of background agents in the transcript so lost, failed, and killed ones no longer appear as completed, and include the resume agent id and recovery instructions in the failure notification so the model can resume reliably.
- Recover from provider model token limit errors during long conversations.
- Automatically retry when a model response stream is dropped mid-flight (a `terminated` error) instead of failing the turn.
- Handle context overflow errors consistently across provider responses.
- Back off failed compaction retries by a fixed slice of the model context window.
- Fix the native self-updater reporting a successful update when the install command actually failed.
- Project persisted hook and blocked prompt messages into model context.
- Keep blocked prompt hook conversations available to subsequent model turns.
- Fix footer leaking onto the terminal when resuming a non-existent session.
- Fix automatic ripgrep installation when temporary files are on another filesystem.

### Polish

- Remove the default per-turn step limit of 1000. Users can still set `max_steps_per_turn` in config to enforce a custom limit.
- Support querying sessions by sessionId or workDir in listSessions, and show a helpful cd command when resuming a session from a different working directory.
- Expand the footer's rotating tips to surface more commands and shortcuts, featuring newer and important ones more prominently.
- Improve the usage information display in the TUI.
- Restrict plugin trust badges to Kimi-hosted plugin CDN URL patterns.
- Clarify subagent and background task stop messages as user-initiated.
- Align the datasource plugin with the generic two-tool workflow.

### Refactors

- Introduce `ModelProvider` interface and `SingleModelProvider` to decouple `Agent` from `ProviderManager`.
- Split `RuntimeConfig` into `Kaos` and `ToolServices` and update all references accordingly.
- Slim the LLM diagnostic logs with fewer, more compact fields.
- Relocate shared tool service typing to the tool support layer.

## 0.5.0 (2026-05-28)

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

## 0.4.0 (2026-05-27)

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

## 0.3.0 (2026-05-26)

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

## 0.2.0 (2026-05-26)

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
