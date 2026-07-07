---
outline: 2
---

# Changelog

This page documents the changes in each Kimi Code CLI release.

## 0.23.0 (2026-07-06)

### Features

- web: Add an Archived sessions page in Settings to browse and restore archived sessions. Open Settings → Archived to find it.
- Add experimental on-demand tool loading (`select_tools`) under the `tool-select` flag: a supporting model loads MCP tools only when needed instead of sending all of them in every request, preserving the provider prompt cache. Off by default and only active on models that declare the `select_tools` capability.

### Bug Fixes

- Fix sessions that exist on disk but were missing from the session list or returned 404 on direct access, by rebuilding the session index at server startup.
- Fix the Bash and Edit tool cards collapsing, jumping, or flickering in height when results stream in or finish with short output, and visually separate the Bash command from its output.
- Fix the input box shifting upward after the slash command menu closes.
- Fix the edit approval preview shown by Ctrl+E to include surrounding context lines, matching the summary panel.
- Fix `@` file completion missing deeply nested files in large projects after adding extra workspace directories.
- web: Fix several web layout and animation glitches: the collapsed sidebar now hides correctly, the chat history no longer replays its entrance animation when opening a session, and tool components no longer jump the conversation when expanded or collapsed.
- web: Fix scheduled-reminder (cron) fires being hidden; they now show as notice cards in the chat.
- web: Fix the end of a reply staying missing after reopening a session.
- web: Fix queued media messages not loading back into the composer and keep attachments when undoing a message.
- web: Keep the composer toolbar from clipping its controls on narrow windows and phones, with the context ring staying visible at every width.
- web: Fix the font size setting so chat text, composer text, and sidebar text follow the selected size. Thanks @justjavac!
- web: Fix an almost-invisible composer input caret and a washed-out strikethrough on completed todos.
- web: Show the correct session search shortcut on Windows. Thanks @justjavac!
- Fix tool calling with Google Gemini models, including Gemini 3 thinking-signature round-trips across turns.

### Polish

- web: Replace the swarm footer with a single inline tool card that shows live subagent progress and the aggregated result, and keep the swarm progress bar stable after refresh.
- Show compaction summaries in the TUI after compaction. Press Ctrl+O to show or hide the summary.
- web: Render AskUserQuestion answers as a readable option list with the chosen option(s) highlighted, instead of raw JSON.
- web: Show available skills in the composer before a session is created.
- web: Add an Archived sessions entry to the mobile settings sheet and clarify the archive confirmation to mention restoring from Settings.
- web: Show the Kimi icon and clearer titles in desktop notifications.
- web: Align the markdown diff code block with the design system: code text keeps the normal ink colour while the sign and a soft row background carry the change, matching the `~/diff` panel.
- web: Prevent chat text from hyphenating at line breaks and render code without font ligatures.
- web: Drop the stray left indent in the tool-call card body so expanded content aligns with the header.
- Feed AskUserQuestion answers back to the model as question text and option labels instead of positional ids, so the model no longer has to map them back. Question texts must now be unique per call and option labels unique per question; existing clients keep answering with option ids, so no client change is required.
- Keep prior reasoning across turns for Kimi models by default when Thinking is on. Set `[thinking] keep = "off"` to disable.

## 0.22.3 (2026-07-04)

### Bug Fixes

- Wait for background subagents to finish and respond to their results before exiting in `kimi -p`, instead of ending the turn early.
- web: Fix uploaded videos failing to play in the web chat.
- Revert the recent TUI transcript rendering changes to the original upstream behavior and fix related rendering issues.

### Polish

- Add `--dangerous-bypass-auth` and `--keep-alive` flags to `kimi server run`, so the server can run without a token on trusted networks and stay alive past the idle timeout.
- web: Add click-to-enlarge for images uploaded in the web chat. Click an image in a message to open it.

## 0.22.2 (2026-07-03)

### Bug Fixes

- Fix sessions silently dropping later user messages after a turn was interrupted between a tool call and its result.
- Fix requests being rejected by strict providers when the model emits duplicate tool call ids.
- Fix `kimi upgrade` failing on Windows with a spawn error when installing the new version.
- Fix duplicated transcript content appearing in scrollback during streaming.
- Fix compressed-image prompts leaking an internal `<system>` compression note into the visible message and the session title.
- Keep automatic background updates from flashing a console window on Windows.

### Polish

- Have context-compaction notes capture a forward plan for the remaining work — upcoming steps, settled decisions, and foreseeable obstacles — instead of only the immediate next step, so the agent continues more coherently after auto-compaction.
- Enrich PATH from the user's login shell at startup, so shell commands find user-installed tools (e.g. Homebrew's `gh`) even when kimi-code was launched without the full profile PATH.
- Promote the language-matching rule to a dedicated section in the system prompt, so replies and reasoning consistently follow the user's language through long English tool output, while repository artifacts keep project conventions.
- Add a TUI preference to keep rapid multi-line pastes from submitting line by line when bracketed paste is unavailable. Set `disable_paste_burst = true` in `tui.toml` to turn it off.
- Keep subagent cards at a stable height and show a live status spinner with a compact two-row activity window.
- In `kimi -p` runs, wait for background subagents to finish before exiting when `background.keep_alive_on_exit` is enabled. Set `keep_alive_on_exit = true` to let concurrent background subagents complete.

### Refactors

- Record model response ids in session wire logs to make individual model requests easier to trace.

## 0.22.1 (2026-07-02)

### Bug Fixes

- Fix TUI rendering bugs that caused the screen to go blank and the input box to disappear.
- Fix the TUI crashing when the terminal is resized to a very narrow width while the input contains CJK or emoji text.
- Fix the web UI becoming sluggish after opening many sessions.
- Clear the screen fully when starting a new session via /new, /clear, or a session switch.
- Fix web tooltips that could get stuck on screen when their trigger element is removed while open.
- Fix the sidebar session row shifting its title and status badges when hovered.
- Fix the session search dialog showing a horizontal scrollbar for long session titles or snippets.

### Polish

- Improve compaction handoff summaries for more reliable resumed sessions. They now keep the latest intent, key tool results, decisions, open questions, and context to re-check.
- Save shell commands to input history and recall them in bash mode. Press Up on an empty `!` prompt to browse previous shell commands.
- When large images are compressed, tell the model the original and delivered image details. Keep the original image available, and support cropped or full-resolution reads for fine details.
- Refresh the web UI icon set and unify the message copy and undo button hover states and tooltips.
- Let the web sidebar collapse an expanded workspace session list back to its first page.
- Trim redundant and incorrect tooltips in the web UI.
- Show an up arrow on the web composer send button.

### Refactors

- Remove the experimental micro compaction feature and its toggle from the experiments panel.
- Remove duplicate newline-shortcut handling from the prompt editor.

## 0.22.0 (2026-07-02)

### Features

- Automatically compress oversized images before they reach the model, downsampling and re-encoding them to cut vision-token cost and avoid provider image-size errors.
- Add model alias overrides, letting you set model metadata under `[models."<alias>".overrides]` to override provider catalog refresh results.

### Bug Fixes

- Fix plan, swarm, and goal modes being shared across sessions in the web UI; each session now keeps its own toggles.
- Fix the transcript jumping to the top when scrolling up through history during streaming output.
- Release pasted images and streaming timers once they are no longer shown, so memory stops growing in long sessions.
- Fix the terminal being left in raw mode with a hidden cursor and disabled flow control after a crash or abrupt exit.
- Fix an active workspace showing only its five most recent sessions on load, so it now keeps loading older sessions from the last 12 hours.
- Fix the Thinking-by-default setting not taking effect, so new sessions correctly start with thinking enabled.
- Fix spurious errors from the web question, approval, and task actions when the action was already complete, and add loading feedback so each click is acknowledged immediately.
- Show draft pull requests with a distinct draft status instead of displaying them as open.
- Hide the conversation outline when there is not enough room to expand its labels, so it no longer clips against the window edge.
- Hide the unsupported Off option in the /model thinking switcher for always-on models that already expose multiple effort levels.

### Polish

- Refresh the web UI with a new design system, including updated colors, typography, spacing, light and dark palettes, restyled tooltips, and subtle enter/exit and expand/collapse animations.
- Group consecutive tool calls into a collapsible stack with per-tool renderers, including diff line-count chips for edits and inline previews for image, video, and audio results.
- Improve session search with a Cmd/Ctrl+K palette that filters by title, workspace, and last prompt with highlighted matches. Press Cmd+K or Ctrl+K to open it.
- Show queued prompts inline below the running turn in the web chat, and split Stop into its own button so Send no longer interrupts.
- Show the conversation outline as one entry per user query that expands into a labeled list on hover.
- Replace the Explore and Native theme options with a single chat layout and a Blue or Black accent-color setting.
- Add workspace sorting by manual order or last-edited time, plus collapse-all and expand-all controls, to the sidebar.
- Show time, duration, connection, and stack details in web error and warning toasts.
- Use one consistent modal dialog for confirmations in the web UI (archive session, delete workspace, delete provider, undo message, and mode toggles).
- Reduce the default TUI transcript window to keep long sessions responsive.
- Reduce the web composer's default height for a more compact empty state, and fix ArrowUp recalling the previous message while editing a multi-line draft; ArrowUp now recalls only from the very start of the text and is disabled in the expanded editor.
- Remove the fade-out animation when undoing a message in the web chat.

## 0.21.1 (2026-07-01)

### Bug Fixes

- Keep the waiting spinner visible while encrypted reasoning streams, fixing a blank spinner-less gap before the first response text appears.

## 0.21.0 (2026-07-01)

### Features

- Plugins can now provide slash commands via a `commands` field in their manifest, registered as `<plugin>:<command>` and invoked with `$ARGUMENTS` expansion.
- Add Mermaid diagram rendering to the web chat. Fenced `mermaid` blocks in assistant responses now render as diagrams. KaTeX math and Mermaid diagram parsing also run in Web Workers to keep the UI responsive during live streaming.

### Bug Fixes

- Stop a malformed message history from permanently bricking a session on strict providers (Anthropic). The request is repaired before sending — orphaned tool calls are closed and empty/whitespace-only text blocks dropped — and if the provider still rejects its structure, it is resent once with a wire-compliant rebuild.
- Force-exit headless runs (`kimi -p`) so a stray ref'd handle left over from the run can't keep a completed run alive until an external timeout, and bound prompt cleanup so a wedged shutdown step can't hang shutdown.
- Fix @ file mentions not opening when typed inside a slash command argument.
- Fix adding a workspace by path in the web UI failing silently when the daemon rejects the path; it now shows an error instead of a broken workspace.
- Fix duplicate workspaces showing in the web sidebar when the same folder is registered more than once.
- Fix the web workspace rename not persisting after a page refresh.

### Polish

- Add a double-Esc shortcut to open the undo selector. Press Esc twice while idle to undo.
- Show file path completions when typing `/` in shell mode (`!`).
- Always show the usage-data opt-out toggle in the web settings with a clearer label and description.

### Refactors

- Rework conversation compaction:
  - Keep only recent user prompts plus a single user-role summary; drop assistant and tool messages.
  - Repair tool_use/tool_result adjacency before sending, fixing a strict-provider HTTP 400 when a tool call and its result became non-adjacent.
  - Merge consecutive user turns for strict providers (Gemini/Vertex), fixing an HTTP 400 ("roles must alternate") after compaction or when a turn is steered in right after a tool result.
  - Micro-compaction now defaults off.
- Refactor the thinking effort system
- Add a server-side key-value store API for persisting web UI preferences to the user's data directory.

## 0.20.3 (2026-06-30)

### Bug Fixes

- Fix provider error messages rendering as blank lines in the TUI when the server returns an HTML error page.
- Fix the web composer being hidden behind the mobile Safari toolbar and the page auto-zooming when the composer is focused.

### Polish

- Refresh provider model lists automatically in the background instead of only at startup, so newly available models appear without restarting.
- Glob now uses ripgrep, so it respects .gitignore by default, supports brace patterns, returns only files, and keeps partial results with a warning when some directories are unreadable.

### Refactors

- Align malformed tool call argument handling with schema validation fallback.

## 0.20.2 (2026-06-29)

### Features

- Support the Anthropic-compatible protocol for Kimi Code, including video input.
- Add a completion sound and question notifications to the web UI, with separate Settings toggles for completion notifications, question notifications, and sound. Question notifications default off so question text only reaches your desktop after you opt in.
- Add `KIMI_CODE_CUSTOM_HEADERS` for custom outbound LLM request headers, and send the `User-Agent` header to non-Kimi providers. Set `KIMI_CODE_CUSTOM_HEADERS` to newline-separated `Name: Value` lines.
- Add an optional `exclude_empty` parameter to the session list API to omit sessions that have no messages.

### Bug Fixes

- Recover from provider 413 context overflows by compacting before retrying.
- Cap compaction output at 128k tokens by default to avoid provider `max_tokens` errors.
- Fix compaction ignoring the configured max output size.
- Fix unnecessary full-screen redraws when typing in the input box or toggling the slash panel.
- Keep unsent composer attachments scoped to their session in the web UI, so switching sessions no longer leaks them into another session's next message.
- Fix the web composer occasionally keeping typed text after sending the first message of a new session.
- Fix debug timing output lingering after undoing a turn.
- Fix working tips getting squeezed against the agent swarm progress bar.

### Polish

- Rework the web ask-user-question card into a step-by-step wizard so multi-question navigation and the final Submit action are easier to see.
- In the bundled web UI, a new session is now created only when the first message is sent, so `+ New` without a workspace opens the composer instead of making an empty session.
- Restore each session's scroll position when switching back to it in the web UI.
- Keep the open side panel when switching between sessions in the web UI.
- Scope the web composer's up/down input history to the current session instead of sharing it across all sessions.
- In the bundled web UI, `/new` and `/clear` are now aliases that open the session onboarding composer and focus the input. iOS auto-zoom is prevented by keeping text inputs at 16px instead of disabling viewport scaling.
- Hide unused "New Session" entries from the web session list by default.
- Remove the `/sessions` slash command from the web UI; the sidebar already covers session browsing.
- Show the first five sessions per workspace in the web sidebar instead of ten.
- Replace the web composer attach button's plus icon with an image icon.

### Refactors

- Route Kimi Code models on the Anthropic-compatible protocol through the beta Messages API.
- Upgrade web markdown renderer dependencies (katex, markstream-vue, shiki) for bug fixes and performance improvements.
- Add provider type and protocol attributes to turn and API error telemetry.

## 0.20.1 (2026-06-26)

### Features

- Plugins now support declaring lifecycle hooks in `kimi.plugin.json` to run scripts at specific stages. See [Hooks in Plugins](../customization/plugins.md#hooks-in-plugins).
- `/feedback` now supports attaching diagnostic logs and codebase context.
- Add the `kimi update` command, equivalent to `kimi upgrade`, for upgrading to the latest version.
- `kimi web` adds the `--allowed-host <host>` option to add a specified Host to the DNS-rebinding allowlist; 403 errors now explain how to allow it via `--allowed-host` or `KIMI_CODE_ALLOWED_HOSTS`, e.g. `kimi web --allowed-host example.com`.

### Bug Fixes

- Fix kimi server failing to start on Windows after the first run.
- Fix the Web UI opened by the `/web` command not signing in automatically; the terminal now prints the access token.
- Cap chat-completions providers' `max_tokens` to the remaining context window, avoiding context overflow and invalid parameter errors.

### Polish

- Optimize the default system prompt and built-in tool descriptions to stop the agent from blocking background tasks, unify tool guidance across profiles, and surface previously missing tool-result details (fetched-page mode, Grep match totals).
- Cache rendered message lines to keep the terminal responsive in long conversations.
- Retain only recent turns in the transcript and collapse older steps within each turn to keep long sessions responsive.
- Make the web chat input grow with its content and add an expandable editor for longer messages.
- Show the done / in progress / pending breakdown of hidden todos in the collapsed todo panel.

## 0.20.0 (2026-06-26)

### Features

- Add shell mode to the TUI. Type `!` in the input box to enable it. For long-running commands, press Ctrl+B to move them to the background. For example, you can run `!gh auth login` to sign in to the GitHub CLI without opening a new terminal.
- Add a `--host` CLI option so `kimi web --host` can expose the server to the internet, with hardened token authentication, rate limiting, and other security measures.
- Render LaTeX display math (`$$…$$`) in the web UI.

### Bug Fixes

- Fix a startup crash on Linux caused by an unhandled native clipboard error.
- Fix `kimi web` and `/web` failing to start the background server daemon on Windows with `spawn EFTYPE` when the CLI is installed via npm/pnpm or run from source. The official single-binary install script was not affected.
- Fix the terminal window repeatedly losing focus on Linux Wayland, which broke IME input.
- Stop auto-dismissing questions in the web UI after 60 seconds so they wait for the user's answer.
- Fix explore subagents silently losing git context when git commands time out or the directory is not a repository.
- Fix Ctrl-C during compaction so it clears a pending editor draft first instead of cancelling immediately.
- Fix MCP server working directories when sessions are hosted by the web server.
- Fix duplicate session snapshot reloads in the bundled web UI during resync.
- Fix truncated skill descriptions missing an ellipsis in the model's skill listing.

### Polish

- Redesign `/plugins` as a single tabbed panel: **Installed** (manage installed plugins — toggle, remove, MCP, details, reload), **Official** (Kimi-maintained marketplace plugins), **Third-party** (marketplace plugins from other publishers), and **Custom** (install straight from a GitHub URL, zip URL, or local path). Use `Tab` / `Shift-Tab` to switch tabs.
- Show a line-by-line diff when the agent edits or writes a file in the web chat.
- Show the plan body and approach choices in the plan review card when exiting plan mode in the web UI.
- Show the full accumulated progress of a subagent in its detail panel, with concise tool-call summaries instead of raw JSON.
- `/reload` now refreshes the assistant's view of plugin skills, so plugin changes take effect in the current session instead of requiring a new one.
- Replace silent AGENTS.md truncation with a visible warning in the TUI status bar and web UI.
- Add a confirmation prompt before installing third-party plugins.
- Show update badges on the `/plugins` Installed tab, where Enter now installs the available update and I opens plugin details.
- Add a copy button to user messages in the web chat.
- Preserve full tool output logs when previews are truncated and link background task completion notifications to saved output.
- Sync session title changes across all connected clients in server mode.
- Add Ctrl+U and Ctrl+D as page up and page down shortcuts in the task output viewer.
- Add a hint to the per-turn step limit error pointing users to the `loop_control.max_steps_per_turn` config option.
- Reduce streaming redraw cost for long assistant messages with code blocks.
- Page the web session list per workspace so the first screen no longer fetches every session up front.
- Keep the web session sidebar from re-rendering on every streaming token to improve rendering performance.
- Create missing parent directories automatically when writing a file.
- Improve the image paste hint.

## 0.19.2 (2026-06-24)

### Features

- Keep drag-and-drop workspace reordering in the web sidebar, with sort order persisted locally; sessions now also float to the top of their group as soon as a new message arrives.
- Add an Alt+S shortcut in the model picker to switch the model for the current session only, without saving it as the default.
- Add a Ctrl+T shortcut to expand and collapse a truncated todo list.
- Add `-c` as a shorthand for `--continue`.

### Bug Fixes

- Fix yolo mode in the web app auto-approving plan reviews and sensitive file access.
- Fix resume not realigning a tool call that was interrupted mid-history.
- Fix the composer's ↑/↓ input-history recall doing nothing right after the first message of a new session.
- Fix stale rows occasionally leaving duplicate input boxes after tall content shrinks.
- Fix inline images being rendered as broken escape sequences in the transcript.
- Fix code blocks nested inside list items rendering blank in the web chat after a turn finishes generating.
- Fix the Tab key unexpectedly opening the file completion list.
- Fix clipboard copy actions in the web UI when served over plain HTTP.
- Fix the web question prompt missing the free-text Other option.
- Fix web chat stop actions so stale prompt ids fall back to cancelling the active session.

### Polish

- Read large text files in bounded memory and read tail lines without scanning whole files.
- Show the command in running Bash tool cards and allow expanding it with Ctrl+O before the result arrives.
- Allow the web sidebar and detail panel to be resized up to the available viewport width, keeping their resize handles reachable on narrow windows.
- Show subcommand suggestions after Tab-completing a slash command name.
- Show a transient footer hint when an image is detected in the clipboard, displaying the platform-appropriate paste shortcut.
- Persist the collapsed state of workspace groups in the web sidebar across page reloads.
- Add a development-mode indicator to the web sidebar for local development.
- Optimize the loading tips display.

### Refactors

- Reorganize the web app's components into area subdirectories (chat/settings/dialogs/mobile) and refresh the component path comments.
- Extract several composer pieces into reusable composables.
- Extract pure turn-rendering helpers out of the chat pane into their own module.
- Extract the beta conversation outline (table of contents) into its own component.
- Extract the workspace group rendering out of the sidebar into its own component.

## 0.19.1 (2026-06-23)

### Bug Fixes

- Fix ACP editors such as Zed failing to start a new thread.
- Fix the web sidebar's unread dots getting out of sync across browser tabs.
- Clear all per-session state when a session is archived or removed, so archived sessions no longer leave orphaned data behind.

### Refactors

- Consolidate web client localStorage access and split the root state store and app shell into focused composables.

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
