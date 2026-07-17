---
outline: 2
---

# Changelog

This page documents the changes in each Kimi Code CLI release.

## 0.26.0 (2026-07-16)

### Features

- Expand the coder subagent tool set to include background tasks, todo lists, plan mode, skill invocation, and nested agents, mirroring the main agent's capabilities; a subagent run also waits for its background tasks to settle before reporting completion.

### Polish

- Optimize the unit formatting of the context usage display.
- Warn in the /model and /effort pickers that switching invalidates the existing prompt cache, and hint to use /new to avoid extra token costs.
- web: Refresh the model catalog for all providers when opening the model picker, so newly available models always show up.

### Bug Fixes

- Fix Kimi-provider models routed through the Anthropic protocol incorrectly showing reasoning effort options.
- Honor an explicit thinking "off" on OpenAI-compatible providers: it used to be indistinguishable from never configured, so the history-based auto reasoning_effort injection kept the model reasoning.
- web: Fix the sidebar resize handle being covered by the chat composer background.
- Keep legacy migrations idempotent across multiple Kimi homes and report damaged or unmapped sessions instead of silently skipping them.
- Replay empty thinking content verbatim instead of substituting a placeholder space on Anthropic-compatible and Kimi preserved-thinking endpoints.
- Report when users stop tasks and preserve other stop reasons in model context.
- Fix a resumed session being marked as just updated and jumping to the top of the session list without any new activity.
- Fix a race where resuming a background subagent right after it was manually stopped could fail with an "already running" error.
- Fix the context size indicator under-reporting the model's actual context usage.

## 0.25.0 (2026-07-16)

### Features

- web: Attach any file type in chat — files can be dropped anywhere in the window, and sent files, images, and videos show as chips in the message bubble.

### Polish

- web: Show full diagnostics for model request failures.
- Apply official Anthropic effort profiles and a 128k output fallback for unknown models.

### Bug Fixes

- Fix the web server bearer-token check being bypassed by percent-encoded API paths, which allowed unauthenticated access to every API route.
- Fix the session filesystem API following symlinks that point outside the workspace, which allowed accessing host files beyond the session directory.
- web: Keep session activity indicators in sync with agent work and prevent duplicate streamed content after session activation races or LLM retries.
- Fix custom-named models on Anthropic-compatible providers starting new sessions with thinking effort off and not showing the thinking control in ACP clients.
- Honor adaptive_thinking = false on Anthropic-compatible models by omitting the effort parameter from requests.
- web: Fix the Content-Security-Policy on non-loopback server binds blocking the web UI's theme bootstrap script and bundled fonts.
- Fix sessions failing to be created when the workspace directory is given through a symlink.
- Fix the CLI exiting unexpectedly when reading an image from the clipboard fails; it now falls back to pasting text.
- web: Fix completed background subagents losing their final output after a session reload.
- web: Fix Enter not confirming modal confirmation dialogs in dev builds.
- web: Fix a background subagent showing up as two identical rows in the agents dock panel during streaming.
- Fix the diagnostic log missing the actual error when the CLI exits unexpectedly.

## 0.24.2 (2026-07-15)

### Features

- Add a builtin `/check-kimi-code-docs` skill that automatically answers Kimi Code product questions with official-docs sources.

### Polish

- Align `kimi -p` behavior across engines: `print_background_mode` and `print_max_turns` now apply, and `/goal` runs stay alive until the goal finishes.
- `kimi -p` now stays alive by default while background tasks are pending, with no effective wait or turn limit, and feeds each completion back to the agent. Set `print_background_mode = "exit"` or `"drain"` to restore the old exit-after-one-turn behavior.
- `kimi -p` background tasks and subagents no longer time out by default (interactive mode is unchanged); restore limits with `[background] bash_task_timeout_s` or `[subagent] timeout_ms`.
- Subagent timeout now defaults to 2 hours everywhere; override with `[subagent] timeout_ms` or `KIMI_SUBAGENT_TIMEOUT_MS`.
- The per-step LLM retry limit is raised from 3 to 10 attempts, so transient provider failures (429 / overload) are retried before a turn fails; tune with `loop_control.max_retries_per_step`.
- Workspaces now stay in sync: new sessions register automatically, missing workspaces are restored at startup, and removed ones stay removed.
- `kimi web` now logs failed requests and key operations so daemon issues are easier to diagnose.
- web: AgentSwarm cards now stay expanded while subagents are still running.
- web: Minimized plan review and question cards now use an upward chevron for expand.

### Bug Fixes

- web: Fix mobile layout on iOS, including the composer, safe areas, and toasts.
- Fix new sessions not opening in older CLI versions.
- Fix completion notifications firing early when a subagent finished while the main turn was still running.
- Fix the web UI showing the wrong CLI version.
- Fix Gemini tool call IDs colliding across turns and merging swarm runs into one card.
- web: Show server error details when actions like stopping or archiving a session fail.
- web: Fix long responses getting stuck when the tab is backgrounded.
- web: Fix copy button on code blocks not working on plain HTTP.
- web: Fix session list being cleared after a failed refresh.
- web: Fix the AgentSwarm member list missing after a page reload.
- web: Fix session titles not generating when the first message is a slash command.
- web: Fix message timestamps showing the session creation time after reloading a session.
- Fix multiple /goal mode issues: budget and turn limit enforcement, pause and resume, crash recovery, final status messages, and invalid persisted goal records.
- Fix a replaced goal still affecting the new goal's budget, and reject invalid subagent goals consistently.
- Fix the guidance text shown when a goal cannot be paused or resumed.

### Refactors

- Rename the dynamic tool loading capability from `select_tools` to `dynamically_loaded_tools`; behavior is unchanged.

## 0.24.1 (2026-07-14)

### Bug Fixes

- Fix Kimi sessions hanging when preserved-thinking history contains empty reasoning steps.
- Fix built-in tools being unavailable when the model provider initializes after session start.
- Fix thinking effort routing: non-Kimi providers now preserve configured values, Kimi models validate runtime selections and fall back safely during model resolution.
- web: Align web and CLI thinking level handling: selected levels are submitted as-is, not silently downgraded; unselected or model-switched sessions fall back to the model's default; explicit selections are saved as defaults and inherited by new sessions.
- Fix goal completion summaries being lost; untyped LLM errors in step interruption events no longer show internal error code prefixes.

### Polish

- web: Model labels show only the level name (e.g., Max), no longer "thinking: max".

## 0.24.0 (2026-07-14)

### Features

- web: Add session export, run `/export` or select "Export session" in the session more menu to download a ZIP with the session and troubleshooting logs (up to 64 MiB).
- Foreground `Bash` commands that time out are no longer killed; instead they move to the background and report results when done. Set `bash_auto_background_on_timeout = false` in `[background]` in `config.toml` to restore the old kill-on-timeout behavior.

### Polish

- web: Polish `/goal` mode controls with an animated bar interaction, budget-aware progress bar, and design-system-aligned cancel confirmation.
- Polish session close: request background tasks to stop with a grace period before force-stopping remaining tasks.
- Rewrite the repeated tool call reminder to guide the agent toward alternative actions instead of forbidding the call.
- Polish `TaskOutput` tool prompt to prevent the agent from blocking on background tasks.
- Send a `kimi-code-cli` User-Agent header when fetching provider registry (api.json) and model catalogs.
- Warn when a skill fails to parse instead of silently dropping it; fix the skill scan report being omitted.

### Bug Fixes

- Fix oversized images corrupting the session; sessions that already failed with request-too-large errors now auto-recover.
- Fix session forks losing content: forked sessions now retain media attachments, plan files, background task output, and cron tasks; failed forks no longer leave a broken copy.
- web: Fix multiple rendering glitches on session reopen, reconnect, or resync, including the context usage indicator resetting to zero, user message bubbles duplicating, and text duplication across multi-step turns.
- web: Fix uploaded images not showing when connecting to the server through a non-localhost address.
- web: Fix a blocked goal not resuming after unblocking from the /goal controls.
- web: Fix the AgentSwarm member list disappearing after a page reload while subagents are still running.
- web: Fix the goal card disappearing after a page reload while a session goal is active.
- web: Fix the workspace picker menu being too narrow for its content.
- web: Fix transient subagent rate limits surfacing as session errors; they now recover automatically.
- Fix Bash auto-detection failing on Windows when git comes from a native MSYS2 toolchain (ucrt64/clang64/clangarm64).
- Fix OAuth login hanging after browser authorization when the provider configuration changes during the login flow.
- Fix OAuth-hosted models persistently showing a re-login prompt when tokens return 401 after refresh; now shows the provider's actual rejection reason.
- Fix providers without a configured `base_url` being rejected: anthropic/openai protocol providers now fall back to their official default endpoints as before.
- Fix MCP tools being unavailable on the first turn after session start.
- Fix pasted media and images being dropped in `/skill` and plugin command arguments, and images being dropped when submitted with Ctrl-S.
- Fix empty reasoning blocks being dropped across providers, breaking multi-step tool calls.
- Fix plan mode exit under auto permission being marked as "user reviewed": now correctly marked as auto-approved, so the agent no longer treats it as a signal to start executing.
- Fix background tasks potentially being lost or falsely marked as missing when resuming a session.
- Fix server potentially leaving stale instance files after shutdown.

### Refactors

- `kimi web` now defaults to the refactored agent engine.

## 0.23.6 (2026-07-12)

### Polish

- web: Render wide Markdown tables beyond the reading column width up to 1040px, with horizontal scrolling inside the table for wider content.
- web: The server access token persists for up to 7 days after closing the tab or restarting the browser, so re-entering it on every new tab is no longer needed.
- web: The workspace picker search box supports entering absolute paths to add workspaces, with real-time validation and completion suggestions.
- web: Automatically enable the default thinking effort when switching to a model that supports thinking effort levels.
- Recognize `support_efforts` and `default_effort` fields in custom registry imports so these models can have thinking effort configured.
- Update the WebBridge install page link in the /plugins panel.
- Add `subagent.timeout_ms` config (or `KIMI_SUBAGENT_TIMEOUT_MS` env var) to control individual subagent timeout, raising the default from 30 minutes to 2 hours.
- Add print-mode background policy: set `[background].print_background_mode = "steer"` to keep `kimi -p` alive after background tasks finish, steering the main agent into further turns.

### Bug Fixes

- web: Fix sessions getting stuck in a sending state after reconnect; turns completed during the disconnect now properly finish loading and allow the next message.
- web: Fix the initial auth check failing and redirecting to the login page on first visit after a web UI start or update; now stays on the connecting screen, shows the connection error, and keeps retrying.
- Fix `kimi -p` exiting after the main turn ends when a goal is still active or a cron task is pending; goal continuation and cron task firing now execute their turns properly.
- Fix dismissing a question prompt defaulting to the recommended option; now treated as the user choosing not to answer.
- web: Fix ReadMediaFile results showing as a generic tool card instead of an image after session resume or reload.
- web: Fix the chat view jumping downward when scrolling through conversation history.
- web: Fix identically named models from different providers being incorrectly selected in the model dropdown; now matches by the unique model ID.
- web: Fix sidebar lag when many sessions are present by removing redundant session list scans during rendering.

### Refactors

- Rename the dynamic tool loading model capability from `select_tools` to `dynamically_loaded_tools`.

## 0.23.5 (2026-07-10)

### Polish

- Improve retry reliability for transient provider errors (429, overload): respect the server's Retry-After header, and expose retry events in `-p --output-format stream-json` output.

### Bug Fixes

- Fix unsupported image formats (AVIF, BMP, TIFF, ICO) corrupting the session; covers all ingestion paths including remote image URLs and mislabeled tools. Stuck sessions auto-recover by dropping the offending image and retrying; a single bad image no longer blocks all subsequent requests.
- web: Fix "Turn finished" desktop notifications and completion sounds firing twice per turn.
- web: Fix internal image compression notes being displayed as visible user message text.

## 0.23.4 (2026-07-10)

### Features

- web: Add notifications for tools requiring approval and improve notification reliability.

### Polish

- web: Polish the chat interface with Inter font, localized labels, and more compact input and menu styles.
- web: Polish the session sidebar layout, colors, icons, and typography.
- `/usage` and `/status` commands now show Extra Usage (top-up) balance.
- The `/plugins` panel Official tab now includes a Kimi WebBridge entry for installing WebBridge from the browser.

### Bug Fixes

- Control request volume for image-heavy sessions: oversized model-read and pasted images (including WebP) are auto-compressed and downscaled; HEIC/HEIF images show platform-specific conversion commands instead of corrupting the session; HTTP 413 request-too-large errors now auto-recover by replacing old media with text markers and retrying. Limits are configurable via `[image]` in `config.toml` (or `KIMI_IMAGE_*` env vars), and each core keeps its own settings so reloading one client's config no longer affects another client's image compression.
- Fix sessions with a deleted original working directory failing to resume.
- Fix prompt mode goals not running to completion; validate and warn about invalid goal commands before sending the prompt.
- web: Fix the occasional "another turn is active" error when sending the first message in a new conversation; show the startup state during send.

## 0.23.3 (2026-07-08)

### Bug Fixes

- Fix the current account incorrectly showing "OAuth login expired" when a model is unavailable.

## 0.23.2 (2026-07-08)

### Features

- The built-in plugin marketplace now includes a Vercel plugin; run `/plugins` and select Vercel Plugin to install.

### Bug Fixes

- Fix `kimi -p` exiting with code 0 even when the turn failed.
- Fix autonomous goals being paused by status updates reported by the model.
- Fix autonomous goal turns not counting toward the goal's turn budget.
- Raise the image downscale cap from 2000px to 3000px, and fix EXIF-rotated (portrait) photos having swapped width and height in compression notes and media read descriptions, so area read-back coordinates are correct.
- web: Fix the connection error hint persisting after WebSocket reconnects from a backgrounded tab.
- Fix a console window flashing on every hook run on Windows.

### Polish

- web: Redesign the scheduled reminder interface.
- web: Show session skills as `/skill:<name>` in the slash menu to distinguish from built-in commands; typing the skill name directly still works.
- web: Switching the model in the input box model picker also updates the global default model, so new sessions inherit the choice.
- web: Support Enter to confirm in archive and other confirmation dialogs.
- Polish goal mode guidance for blocked and completion status updates.
- Progressive tool loading (`select_tools`, experimental): drop loaded tool schemas after compaction and let the model re-select which ones it still needs, keeping the post-compaction context lean. Calls to tools that were not re-loaded are rejected with a prompt to select them first. Only active when the `tool-select` experimental flag is on and the model supports `select_tools`.

### Refactors

- web: Compile icons at build time so the bundled web UI only ships icons that are actually rendered.

## 0.23.1 (2026-07-07)

### Bug Fixes

- Fix `kimi -p` dropping late-starting or long-running background subagents, which prevented their results from returning to the main agent.
- web: Fix the chat stream breaking when the WebSocket in a background tab becomes stale; now auto-recovers.
- Fix some third-party models (e.g. Opus 4.8) incorrectly falling back to the series default max output tokens; unlisted minor versions now reuse the most recent known version's limit.
- Fix an explicitly set Anthropic `max_output_size` being capped to the built-in limit; now respects the user's configured value.
- Fix `<system>` metadata from tools leaking into tool output; failed tools now display their own error message.
- Fix goal update behavior on completion or blocking; now generates a final user-facing result summary from the tool result.
- Fix permission mode not being restored on goal startup failure, and queued goals not waiting for a new user message.
- Fix goal token budget not accounting for model completion tokens; budget exhaustion now stops immediately without extra continuation steps.
- Fix the main agent being unable to use goal tools; return clear guidance for invalid goal control calls.
- Fix the `--skills-dir` option not taking effect in interactive mode.
- web: Fix multiple slash commands and skill activations not working on the new session page: `/goal <objective>` and slash skill activations (e.g. `/pre-changelog`) had no effect, and `/btw [<question>]` opened an empty side chat.

### Polish

- Anthropic provider (Claude and Kimi in Anthropic-compatible mode) now preserves thinking content from historical turns by default, matching Kimi's default behavior; disable with `[thinking] keep = "off"` or `KIMI_MODEL_THINKING_KEEP=off`.
- Polish the permission mode descriptions shown by `/permission`, `/auto`, and `/yolo`; reorder `/auto` and `/yolo` in the command list.
- Long-running goal runtime budget reminders now display in hours.
- Polish goal mode guidance so the agent continues working across turns within reason, without ending goals prematurely.

### Refactors

- Log trace information for each request in the session wire log so model requests can be reconstructed during debugging.

## 0.23.0 (2026-07-06)

### Features

- web: Add an "Archived sessions" page in settings to browse and restore archived sessions; go to Settings > Archived sessions.
- Add experimental on-demand tool loading (`select_tools`): when the `tool-select` flag is enabled, supported models load MCP tools on demand rather than sending every tool on every request, preserving the provider's prompt cache. Off by default, and only applies to models that declare `select_tools` capability.

### Bug Fixes

- Fix sessions that exist on disk being missing from the session list or returning 404 on direct access; the server now rebuilds the session index at startup.
- Fix Bash and Edit tool cards collapsing, jumping, or flickering in height when results stream in or end with short output; visually separate Bash commands from their output.
- Fix the input box shifting upward after the slash command menu closes.
- Fix Ctrl+E edit approval previews missing context lines; now consistent with the summary panel.
- Fix `@` file completion missing deeply nested files in large projects after adding extra workspace directories.
- web: Fix multiple layout and display glitches: the collapsed sidebar now correctly hides, the chat history no longer replays its entrance animation when opening a session, and tool components no longer jump the conversation when expanded or collapsed.
- web: Fix scheduled reminders (cron) being hidden when triggered; now show as notification cards in the chat.
- web: Fix the end of replies still missing after re-opening a session.
- web: Fix queued media messages not being re-loadable into the input box; preserve attachments on message undo.
- web: Fix the input box toolbar controls being clipped on narrow windows and mobile; the context ring stays visible at any width.
- web: Fix font size settings so chat text, input box text, and sidebar text all follow the selected size.
- web: Fix the input cursor being barely visible and the completed-todo strikethrough being too dim.
- web: Fix the session search shortcut showing incorrectly on Windows.
- Fix Google Gemini model tool calls, including Gemini 3 thinking signature round-trips across turns.

### Polish

- web: Replace the swarm bottom bar with a single inline tool card showing real-time subagent progress and aggregated results; keep the swarm progress bar stable after page reload.
- TUI shows a compaction summary after compaction; press Ctrl+O to toggle visibility.
- web: Render AskUserQuestion answers as readable option lists with the selected option highlighted, replacing raw JSON.
- web: Show available skills in the input box before a session is created.
- web: Add an "Archived sessions" entry in the mobile settings panel, and explain in the archive confirmation prompt that sessions can be restored from settings.
- web: Show the Kimi icon and a clearer title in desktop notifications.
- web: Align Markdown diff code blocks with the design system: code text keeps normal text color, with symbols and soft row backgrounds indicating changes, consistent with the `~/diff` panel.
- web: Prevent text from breaking at word boundaries on line wrap; render code without font ligatures.
- web: Remove extra left indentation from tool call card bodies so expanded content aligns with the title.
- AskUserQuestion answers are now sent back to the model as question text and option labels instead of positional IDs, so the model no longer needs to map them back to the original options. Question texts must be unique per call, option labels must be unique per question. Existing clients still answer with option IDs and require no changes.
- Kimi models with Thinking enabled now preserve reasoning across turns by default; disable with `[thinking] keep = "off"`.

## 0.22.3 (2026-07-04)

### Bug Fixes

- `kimi -p` now waits for background subagents to complete and return their results before exiting, preventing the current turn from ending prematurely.
- web: Fix uploaded videos not playing in the web chat.
- Revert recent TUI conversation rendering changes, restoring upstream original behavior and fixing related rendering issues.

### Polish

- `kimi server run` now has `--dangerous-bypass-auth` and `--keep-alive` options to skip token authentication on trusted networks and stay alive beyond the idle timeout.
- web: Uploaded images in the web chat support click-to-expand; click an image in a message to open it in a preview panel.

## 0.22.2 (2026-07-03)

### Bug Fixes

- Fix subsequent user messages being silently dropped when a turn is interrupted between a tool call and its result.
- Fix strict providers rejecting requests when the model emits duplicate tool call IDs.
- Fix `kimi upgrade` failing on Windows due to a spawn error when installing the new version.
- Fix conversation content duplicating in the scroll history during streaming.
- Fix image compression prompts leaking internal `<system>` compression notes into visible messages and session titles.
- Fix automatic background updates popping a console window on Windows.

### Polish

- Polish compaction notes: now record a follow-up plan (next steps, decisions made, anticipated blockers) alongside the next action, so the agent continues more coherently after auto-compaction.
- Supplement PATH from the user's login shell at startup, so shell commands can find user-installed tools (e.g. `gh` from Homebrew) even when kimi-code was started without the full profile PATH.
- Promote the language-matching rule to a standalone section in the system prompt, so replies and reasoning stay in the user's language even after long stretches of English tool output, while repository artifacts still follow project conventions.
- TUI preference: when bracketed paste is unavailable, prevent fast multi-line pastes from being submitted line by line. Set `disable_paste_burst = true` in `tui.toml` to disable this behavior.
- Polish subagent cards: keep a fixed height and show a live status spinner in a compact two-line activity window.
- `kimi -p` now waits for background subagents to finish before exiting when `background.keep_alive_on_exit` is enabled. Set `keep_alive_on_exit = true` to let concurrent background subagents execute.

### Refactors

- Log the model response ID in the session wire log for tracing individual model requests.

## 0.22.1 (2026-07-02)

### Bug Fixes

- Fix the TUI rendering error causing a blank screen and missing input box.
- Fix the TUI crashing when the terminal is narrowed to a very small width while input contains CJK or emoji text.
- Fix web UI becoming sluggish after opening multiple sessions.
- Opening a new session via `/new`, `/clear`, or session switching now fully clears the screen.
- Fix web tooltips staying on screen after the triggering element is removed.
- Fix session rows in the sidebar having their title and status badge shift on hover.
- Fix the session search box showing a horizontal scrollbar when the session title or summary is long.

### Polish

- Polish the compaction handover summary for more reliable session resume: now retains the latest intent, key tool results, decisions, open questions, and context that needs review.
- Bash mode adds shell command history: executed commands are saved to the input history; on an empty `!` prompt, press Up to browse and recall past commands.
- When compressing oversized images, explain to the model what was sent versus what was originally available, and keep the original image so fine-grained detail can still be read by cropping or at full resolution.
- Refresh the web UI icon set and unify the message copy and undo button hover states and tooltips.
- The web sidebar now supports collapsing an expanded workspace's session list back to the first page.
- Trim redundant and inaccurate tooltips from the web UI.
- The web input box send button now shows an upward arrow.

### Refactors

- Remove the experimental micro compaction feature and its toggle in the experiments panel.
- Remove duplicate Enter key handling logic in the prompt editor.

## 0.22.0 (2026-07-02)

### Features

- Auto-compress oversized images that exceed model limits: downscale and re-encode them before sending to the model, reducing vision token costs and preventing provider image-size errors.
- Add model override configuration: set `[models."<alias>".overrides]` with model metadata to override provider refresh results.

### Bug Fixes

- Fix Plan, Swarm, and Goal modes in the web UI being shared across sessions; each session now has its own independent toggle.
- Fix the transcript jumping back to the top when scrolling up through history during streaming.
- Release pasted images and streaming timers after they are no longer displayed, preventing sustained memory growth in long sessions.
- Fix the terminal staying in raw mode with a hidden cursor and disabled flow control after a crash or unexpected exit.
- Fix the active workspace only showing the last five sessions on load; now loads earlier sessions from the past 12 hours.
- Fix the default-thinking-on setting not taking effect; new sessions now correctly start with Thinking enabled.
- Fix web question, approval, and task actions producing spurious errors when the operation is already complete; add loading feedback so every click gets immediate confirmation.
- Draft pull requests now show a distinct draft status instead of being displayed as open.
- Hide the conversation outline when there is not enough space to expand the labels, preventing it from being clipped by the window edge.
- Hide the unsupported Off option in the /model thinking toggle for always-on models that already provide multiple thinking effort levels.

### Polish

- Refresh the web UI with a new design system, including updated colors, typography, spacing, a light/dark palette, redesigned tooltips, and more refined enter/exit and expand/collapse animations.
- Group consecutive tool calls into a collapsible stack with dedicated rendering per tool: edits show diff line counts, and image, video, and audio results support inline previews.
- Improve session search with a new Cmd/Ctrl+K command palette that filters and highlights matches by title, workspace, and last prompt. Press Cmd+K or Ctrl+K to open it.
- In the web chat, show queued prompts inline below the current turn, and separate Stop from Send so Send cannot interrupt by mistake.
- The conversation outline now shows one item per user question, expanding to a labeled list on hover.
- Replace the Explore and Native theme options with a single chat layout, plus a Blue or Black accent color setting.
- The sidebar now supports workspace sorting (by manual order or last edited) and collapse-all/expand-all controls.
- Web error and warning toasts now show the time, duration, connection, and stack details.
- Web confirmation actions (archive session, delete workspace, delete provider, undo message, mode switch) now use a consistent modal dialog.
- Shrink the default TUI transcript window to keep long sessions responsive.
- Shrink the default web input box height for a more compact empty state; fix ArrowUp recalling the previous message when editing a multi-line draft — ArrowUp now only recalls at the very start of the text, and is disabled in the expanded editor.
- Remove the fade-out animation on message undo in the web chat.

## 0.21.1 (2026-07-01)

### Bug Fixes

- Fix the encrypted thinking stream leaving a blank gap before the first response text appears while the waiting spinner disappears.

## 0.21.0 (2026-07-01)

### Features

- Plugins can now declare slash commands in their manifest's `commands` field, registered as `<plugin>:<command>` and expanded with `$ARGUMENTS` when called.
- web chat adds Mermaid diagram rendering; `mermaid` code blocks in assistant replies are now rendered as diagrams. KaTeX math and Mermaid diagram parsing move to Web Workers for better UI responsiveness during streaming.

### Bug Fixes

- Fix malformed message history permanently hanging sessions on strict providers (Anthropic): fix the request before sending by closing orphaned tool calls, dropping blank or purely whitespace text blocks; if the provider still rejects the structure, rebuild it in wire-compliant format and retry once.
- Force-exit headless runs (`kimi -p`) so lingering reference handles no longer keep completed runs alive until the external timeout; also add a deadline to prompt cleanup so a single stuck close step does not hold up the entire shutdown.
- Fix `@` file mentions not opening when typed in slash command arguments.
- Fix daemon path rejection failing silently when adding a workspace by path in the web UI; now shows the error instead of creating a non-functional workspace.
- Fix duplicate workspace registrations for the same folder causing duplicate entries in the web sidebar.
- Fix web workspace renames not persisting after a page refresh.

### Polish

- Add a double-Esc shortcut to open the undo picker: press Esc twice while idle to undo.
- Show file path completions when typing `/` in shell mode (`!`).
- Always show the usage data opt-out toggle in web settings, with improved labels and description.

### Refactors

- Refactor conversation compaction:
  - Keep only the most recent user prompt and a single user-role summary; drop assistant and tool messages.
  - Fix `tool_use`/`tool_result` adjacency before sending, so strict providers no longer return HTTP 400 when a tool call and its result are not adjacent.
  - Merge consecutive user turns for strict providers (Gemini/Vertex) to fix HTTP 400 ("roles must alternate") after compaction or when a steer turn is inserted right after a tool result.
  - Micro-compaction is now off by default.
- Refactor the thinking effort system.
- Add a server-side key-value store API for persisting web UI preferences to the user data directory.

## 0.20.3 (2026-06-30)

### Bug Fixes

- Fix provider error messages showing as blank lines in the TUI when the server returns an HTML error page.
- Fix the web input box being obscured by the mobile Safari toolbar and the page auto-zooming when the input box is focused.

### Polish

- Refresh the provider model list in the background instead of only at startup, so newly available models appear without a restart.
- Glob now uses ripgrep, respects .gitignore by default, supports brace patterns, returns only files, and warns when some directories are unreadable while keeping results from readable ones.

### Refactors

- Align malformed tool call argument handling and schema validation fallback.

## 0.20.2 (2026-06-29)

### Features

- Kimi Code now supports the Anthropic-compatible protocol and video input.
- web UI adds completion sounds and question notifications, with individual toggles for completion, question, and sound in settings. Question notifications are off by default; only users who explicitly enable them receive question text on their desktop.
- Add a `KIMI_CODE_CUSTOM_HEADERS` environment variable for custom outbound LLM request headers, and send a `User-Agent` header to non-Kimi providers. Set `KIMI_CODE_CUSTOM_HEADERS` to newline-separated `Name: Value` lines.
- The session list API gains an optional `exclude_empty` parameter to omit sessions with no messages.

### Bug Fixes

- On provider 413 context overflow, compact first, then retry to recover.
- Cap compaction output at 128k tokens by default to prevent provider `max_tokens` errors.
- Fix compaction ignoring the configured max output length.
- Fix unnecessary full-screen repaints when typing in the input box or switching slash panels.
- Scope unsent input box attachments to the session they were created in; switching sessions no longer leaks them into the next session's message.
- Fix the web input box occasionally retaining typed text after sending the first message in a new session.
- Fix debug timing output lingering after undoing a turn.
- Fix the running prompt being squeezed onto the Agent Swarm progress bar.

### Polish

- Redesign the web AskUserQuestion card as a step-by-step wizard for clearer multi-question navigation and a final Submit action.
- In the built-in web UI, sessions are now created only when the first message is sent, so clicking `+ New` without selecting a workspace opens the input box instead of creating an empty session.
- Restore the scroll position when switching back to a session in the web UI.
- Keep an open side panel open when switching sessions in the web UI.
- Scope the web input box's up/down arrow input history to the current session, no longer sharing it across sessions.
- In the built-in web UI, `/new` and `/clear` now open the session guide input box and focus it as aliases; the input box font size stays at 16px to prevent iOS auto-zoom without disabling viewport zoom.
- Hide unused "New Session" entries from the web session list by default.
- Remove the `/sessions` slash command from the web UI; the sidebar already covers session browsing.
- Show the first five sessions per workspace in the web sidebar, down from ten.
- Replace the web input box attachment button's plus icon with an image icon.

### Refactors

- Route Kimi Code models on the Anthropic-compatible protocol through the beta Messages API.
- Upgrade web Markdown rendering dependencies (katex, markstream-vue, shiki) for fixes and performance improvements.
- Add provider type and protocol attributes to turn and API error telemetry.

## 0.20.1 (2026-06-26)

### Features

- Plugins can now declare lifecycle hooks in `kimi.plugin.json` that run scripts at specified phases. See [Plugin Hooks](../customization/plugins.md#hooks-in-plugins).
- `/feedback` now supports attaching diagnostic logs and codebase context.
- Add `kimi update` command, equivalent to `kimi upgrade`, for upgrading to the latest version.
- `kimi web` adds a `--allowed-host <host>` flag to add extra Host header values to the DNS-rebinding allowlist; the 403 error message now includes guidance on how to allow a host via `--allowed-host` or `KIMI_CODE_ALLOWED_HOSTS`, e.g. `kimi web --allowed-host example.com`.

### Bug Fixes

- Fix kimi server failing to start after the first run on Windows.
- Fix the `/web` command not automatically logging in to the opened web UI; the terminal now prints the access token.
- Chat-completions provider `max_tokens` now does not exceed the remaining context window, preventing context overflow and invalid parameter errors.

### Polish

- Polish the default system prompt and built-in tool descriptions: prevent the agent from blocking background tasks, unify tool guidance across profiles, and enhance tool result display (fetched-page mode, total Grep matches).
- Cache rendered message lines to keep the terminal responsive in long conversations.
- Keep only the most recent turns in the transcript and collapse early steps to keep long sessions responsive.
- The web chat input box now auto-grows with content; long messages can use the expandable editor.
- The collapsed todo panel now shows the status breakdown of hidden todos (done / in-progress / pending).

## 0.20.0 (2026-06-26)

### Features

- TUI adds shell mode. Type `!` in the input box to enable it. For long-running commands, press `Ctrl+B` to move them to the background. For example, run `!gh auth login` to authenticate with GitHub CLI without opening a new terminal.
- CLI adds a `--host` option to expose the server to the internet via `kimi web --host`, with hardened token auth, rate limiting, and other security measures.
- Web UI supports rendering LaTeX display math (`$$…$$`).

### Bug Fixes

- Fix the startup crash on Linux caused by an unhandled native clipboard error.
- Fix `kimi web` and `/web` failing to start the background server daemon on Windows due to `spawn EFTYPE` when the CLI is installed via npm/pnpm or run from source. The official single-binary install script is unaffected.
- Fix the terminal window repeatedly losing focus on Linux Wayland, breaking IME input.
- No longer auto-close questions in the web UI after 60 seconds; wait for the user's answer.
- Fix the explore subagent silently losing git context when a git command times out or the directory is not a repository.
- Fix Ctrl-C behavior during compaction: now clears pending editor drafts first instead of immediately cancelling.
- Fix the MCP server working directory when the session is hosted by the web server.
- Fix the built-in web UI repeatedly reloading the session snapshot during resync.
- Fix truncated skill descriptions in the model's skill list missing an ellipsis.

### Polish

- Redesign `/plugins` as a single tabbed panel: **Installed** (manage installed plugins — toggle, remove, MCP, details, reload), **Official** (Kimi-maintained marketplace plugins), **Third-party** (marketplace plugins from other publishers), and **Custom** (install from GitHub URL, zip URL, or local path). Use `Tab` / `Shift-Tab` to switch tabs.
- Show per-line diffs when the agent edits or writes files in the web chat.
- Show the plan body and option choices in the plan review card when exiting Plan mode in the web UI.
- Show the subagent's full cumulative progress in its detail panel, with a concise tool call summary replacing raw JSON.
- `/reload` now refreshes the assistant's view of plugin skills, so plugin changes take effect in the current session without starting a new one.
- Replace the silent AGENTS.md truncation with a visible warning in both the TUI status bar and the web UI.
- Add a confirmation prompt before installing third-party plugins.
- Show an update badge on the Installed tab of `/plugins`; press Enter to install available updates, I to open plugin details.
- Add a copy button to user messages in the web chat.
- Preserve the full tool output log when the preview is truncated, and link background task completion notifications to the saved output.
- Sync session title changes to all connected clients in server mode.
- Add `Ctrl+U` and `Ctrl+D` as page-up and page-down shortcuts in the task output viewer.
- Add a hint to check the `loop_control.max_steps_per_turn` config in the per-turn step limit error.
- Reduce streaming repaint overhead for long assistant messages with code blocks.
- Load the web session list per-workspace, so the initial page no longer fetches all sessions upfront.
- Avoid re-rendering the web session sidebar on every streaming token for better rendering performance.
- Auto-create missing parent directories when writing files.
- Improve the image paste hint.

## 0.19.2 (2026-06-24)

### Features

- Keep the web sidebar workspace order draggable and persist the order locally; sessions now also float to the top of their group when they receive a new message.
- Add `Alt+S` as a shortcut in the model picker to switch the current session's model only, without saving it as the default.
- Add `Ctrl+T` as a shortcut to expand and collapse the truncated todo list.
- Add `-c` as a shorthand for `--continue`.

### Bug Fixes

- Fix YOLO mode in the web app auto-approving plan reviews and sensitive file access.
- Fix session resume not realigning tool calls that were interrupted mid-history.
- Fix `↑`/`↓` input history recall not working after the first message in a new session.
- Fix occasional stale rows leaving a duplicate input box after taller content collapses.
- Fix inline images being rendered as corrupted escape sequences in the conversation transcript.
- Fix code blocks nested inside list items rendering as blank after a turn finishes in the web chat.
- Fix Tab accidentally opening the file completion list.
- Fix clipboard copy operations failing on the web UI when served over plain HTTP.
- Fix the web question prompt missing the free-text Other option.
- Fix the web stop operation so expired prompt IDs fall back to cancelling the current session.

### Polish

- Read large text files in bounded memory without scanning the entire file to read tail lines.
- Show the command in a running Bash tool card, and allow Ctrl+O to expand it before the result returns.
- Allow the web sidebar and detail panel to resize to the full available viewport width, and keep their resize handles reachable on narrow windows.
- Show subcommand suggestions after tab-completing a slash command name.
- Show a brief bottom hint with the platform-specific paste shortcut when an image is detected in the clipboard.
- Persist workspace group collapsed states across page reloads in the web sidebar.
- Add a dev-mode indicator in the web sidebar for local development.
- Polish the loading hint display.

### Refactors

- Reorganize web app components into domain subdirectories (chat/settings/dialogs/mobile) and refresh component path comments.
- Extract several input box components into reusable composables.
- Extract pure turn-rendering helpers from the conversation panel into a standalone module.
- Extract the beta conversation outline (table of contents) into a standalone component.
- Extract workspace group rendering from the sidebar into a standalone component.

## 0.19.1 (2026-06-23)

### Bug Fixes

- Fix ACP editors (e.g. Zed) failing to start new sessions.
- Fix the web sidebar unread dot losing sync across browser tabs.
- Clear all session state when a session is archived or removed, so archived sessions no longer leave orphaned data.

### Refactors

- Consolidate web client localStorage access and split the root state store from the app shell into single-responsibility composables.

## 0.19.0 (2026-06-22)

### Features

- Add the ability to add extra workspace directories:
  - Use the `/add-dir <path>` command to add an extra working directory to the current session, or remember it for the project.
  - Use `kimi --add-dir <path>` to add them at startup.
  - Project-level local configuration is now managed by `.kimi-code/local.toml`; we recommend adding it to your `.gitignore`.
- Allow moving long-running foreground commands and subagents to the background with `Ctrl+B`, and view them through the `/tasks` panel.

### Bug Fixes

- Provider security policy blocks are now displayed instead of being silently treated as completed turns; prevent the context token count dropping to zero after a filtered response.
- Fix provider request failure when a resumed session's history contains empty text content blocks.
- Detect the real image format from file contents when reading media, so filename-extension mismatches no longer produce data URLs that the model API rejects.
- Fix commands flashing a blank console window on Windows.
- Stop showing unread dots for cancelled or failed sessions in the web sidebar.

### Polish

- Speed up session snapshot loading with a direct disk reader and request timeout protection, while keeping the previous path as a legacy fallback.
- Show longer branch names in the web chat title, with the full name on hover.
- Keep the web page title fixed instead of changing with the session or workspace name.
- Polish the file mention experience.

### Refactors

- Unify image format detection when format sniffing fails.
- Consolidate web client localStorage access and decouple appearance/notification state into dedicated modules.

## 0.18.0 (2026-06-18)

### Features

- Add session filtering in the web sidebar, filtering by title and last user prompt.
- Add lazy loading of earlier messages when scrolling up in the web chat session view.
- Add environment variables to limit AgentSwarm concurrency during the initial ramp phase, making large swarms less likely to trigger provider rate limits.

### Bug Fixes

- Fix the web app only loading the most recent 20 sessions.
- Fix the web slash skill selection sending immediately; allow slash search to match by substring.
- Fix slash commands being visible when the highlight is on a longer slash menu.
- Fix the last session archive showing an incorrect display failure.
- Fix the web login slash command description to match the browser authorization flow.

### Polish

- Redesign the web OAuth login dialog so the step order is no longer ambiguous.
- The version can now be displayed in web settings.
- Allow longer web slash command names and descriptions to wrap, preventing overflow of the slash menu.
- Add a `/reload` hint in the plugin change prompt.

## 0.17.1 (2026-06-17)

### Bug Fixes

- Fix the `kimi web` command failing to start in the background.
- Prevent the background local server from locking the directory it was started in.
- Prevent the web login dialog from closing when clicking the background.

### Polish

- Group the default model dropdown by provider in web settings.

## 0.17.0 (2026-06-17)

### Features

- Add Kimi Code Web mode, started via `kimi web` or `/web` from within the CLI, to continue sessions in a browser chat interface.

### Bug Fixes

- Show the underlying connection error when OAuth token refresh fails after internal retries, instead of prompting to log in. Token refresh failures are no longer retried at the agent loop level.
- Restore the turn counter from persisted loop events when resuming a session, preventing resumed turns from reusing turn IDs that already exist in the history.

### Polish

- Skip debug TPS when the output stream is too short to measure reliably.

## 0.16.0 (2026-06-16)

### Features

- Add a built-in `kimi vis` command to launch the session visualizer in the browser, pointing at local sessions. Supports `--port`/`--host`, `--no-open`, and `kimi vis <sessionId>` deep links.

### Bug Fixes

- Prevent Anthropic-compatible providers from reading ambient Anthropic shell credentials and custom headers.
- Fix repeated compaction handling when the context still exceeds the blocking threshold.
- Prevent session close from resuming the agent when stopping background tasks.
- Session replay range is now built from the rendered replay records, not the raw persisted records.
- Close the wrapped output stream when the buffered reader is destroyed.

### Polish

- Reduce the `/btw` side panel max height from half the terminal to one third.
- Polish the queue panel style.
- Add configurable banner display frequency and maintain local display state.

### Refactors

- Remove redundant LLM request log context propagation.

## 0.15.0 (2026-06-15)

### Features

- Add a full session picker view with search by name, paginated browsing, and copyable resume commands for sessions in other working directories.
- Add support for legacy SSE MCP servers alongside stdio and streamable HTTP transports.

### Bug Fixes

- Fix resumed sessions being unable to continue when interrupted tool call results were not recorded.
- Stop writing resume version markers into persisted agent metadata.
- Migrated config files no longer contain deprecated legacy loop, background, plan, yolo, or unknown experimental flags.
- Fix Xcode 26.5 MCP server emitting JSON Schema types incompatible with Moonshot.

### Polish

- Keep TUI components within narrow terminal widths by wrapping, compacting, or truncating lines that may exceed the render width.
- Before calling more important tools, prompt the CLI to show a brief one-line status message in the user's current language.
- Extend the same-language rule to the model's reasoning process, so thinking content follows the user's language while preserving code and technical terms in their original form.
- When reading media files, prefer the type detected from the file header before falling back to the media extension.
- Prioritize clearing draft editor text before cancelling the active stream on Ctrl-C.
- Fold hidden directories in the workspace prompt and describe how to view them.
- Include the skill's directory in the context block for loaded skills, so the agent can locate its packaged resources (scripts, templates) after invoking a skill.
- Show the full session switch hint when the current working directory has no sessions.
- Clarify that the compaction summary must be output in the final answer.
- Clarify AGENTS.md prompt guidance and mark truncated instruction files.

### Refactors

- Resolve model capabilities through static lookup instead of instantiating a temporary provider.
- Decouple agent skill access from the session-specific registry implementation.
- Optimize the npm packaging system.

## 0.14.3 (2026-06-14)

### Polish

- Refresh provider model metadata before opening the model picker.

## 0.14.2 (2026-06-12)

### Bug Fixes

- Fix endless desktop notifications in iTerm2; only send terminal progress sequences to terminals that support them.
- Correctly display completed and cancelled compaction records when resuming a session.
- Discard invalid `config.toml` sections with a warning instead of failing to start.

### Polish

- Stream stdout and stderr of foreground Bash commands while the command is still running.
- Allow `--auto`, `--yolo`, and `--plan` to be combined with `--session` or `--continue`, applying the requested mode to the resumed session.
- Add a parent prefix to sub-skill names and expose sub-skills as dotted slash commands in the TUI.
- Sync custom registry provider additions, removals, and rotated registry keys during the startup refresh.

## 0.14.1 (2026-06-12)

### Bug Fixes

- Cancel the active turn on session close, preventing foreground shell commands from continuing to run after prompt mode exits.
- Stop background tasks by default on session close.
- Prevent overlapping interactive agent requests from using the wrong active agent.
- Fix a premature stream close error when a shell process times out or is killed.
- Degrade unsupported audio/video to placeholder text and re-attach tool result media, instead of silently dropping them.
- Send OpenAI Responses system prompts as request instructions.
- Propagate configured execution environment overrides to spawned processes.
- Fix ACP file read and edit issues on Windows workspaces opened through IDE clients.
- Require AgentSwarm tool calls to run individually in the model response.

### Polish

- Add runtime support for dynamic MCP server updates, reference skills, replay timestamps, and Node file uploads.
- Add a YOLO option when starting a swarm task from Manual mode.
- Polish built-in skills.
- Look up slash commands by alias in autocomplete — typing `/clear` now suggests `new (clear)`.
- Wrap long command and skill descriptions to a second line in the autocomplete menu instead of truncating.
- Show a tip banner below the welcome panel at startup.

## 0.14.0 (2026-06-10)

### Features

- Add an `Interrupt` hook event, triggered when the user interrupts a turn (e.g. by pressing Esc), so hooks can observe that the turn is stopping instead of being stuck in a working state.

### Bug Fixes

- Preserve tool output images when using OpenAI-compatible Chat Completions.

## 0.13.1 (2026-06-10)

### Bug Fixes

- Prevent forking a session during an active turn; consolidate wire protocol definitions into a shared internal package.
- Fix the Kimi Datasource to use matching OAuth credentials and service endpoints in the current Kimi Code environment.
- Fix goal marker text overflowing the terminal width.

### Polish

- Add support for Claude Fable 5 on the Anthropic provider.
- Add an interactive undo picker and clearer undo limit hint messages.
- YOLO mode no longer asks when writing or editing files outside the working directory.
- Polish the active skill prompt so loaded skills are no longer represented as system reminders.
- Tighten file tool guidance so incremental edits are performed through the Edit tool.

## 0.13.0 (2026-06-10)

### Features

- Add custom color themes. Define your own palette in a JSON file under `~/.kimi-code/themes/`, or use the built-in `/custom-theme` skill command to generate one.
- Add the `/import-from-cc-codex` command to import selected Claude Code and Codex instructions, skills, and MCP settings.
- Show available plugin updates in the marketplace.

### Bug Fixes

- Fix Windows build and dev starts potentially failing due to package binary resolving to a command shim.
- Fix device login keeping the URL and code visible when the browser cannot be opened.

### Polish

- Show grouped subagent progress more clearly with active state breakdowns and elapsed time.
- Truncate queued messages to a single line with an ellipsis when they exceed the terminal width.

## 0.12.1 (2026-06-09)

### Bug Fixes

- Allow outdated experimental config entries to remain without blocking startup.
- Pass through xhigh reasoning effort for OpenAI-compatible Chat Completions requests.

## 0.12.0 (2026-06-09)

### Features

- Add the `/swarm` command to run an Agent Swarm with real-time progress display and rate-limit-aware retries.
- Goals, background questions, and sub-skill discovery no longer require an experimental flag.
- Support standard `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` environment variables (including SOCKS proxies) for all outbound traffic.
- Support Homebrew installation.
- Enable micro compaction by default; disable it in `/experiments`.

### Bug Fixes

- Fix ACP slash skill routing, bootstrap context reading, file and permission edge cases, subagent event handling, and stale file edit messages.
- Fix goal resume behavior by restoring the goal state from agent records.
- Fix subagent thinking text and tool output display.
- Fix session working directory mismatch caused by inconsistent path separators on Windows.
- Fix the `/mcp` status panel border being broken by multi-line MCP server errors; now collapses to a single line.
- Detect Git Bash installed via Scoop and other Git shims on Windows.
- Show the underlying error when migration fails.
- Allow exiting the startup session picker by pressing Ctrl-C or Ctrl-D repeatedly.

### Polish

- Remove the per-turn auto-compaction cap, letting long conversations continue compacting instead of failing early.
- Improve goal mode result handling, including follow-up messages, safer error pausing, and clearer TUI transcript display.
- Show the full plan card directly and remove Plan card keyboard shortcuts.
- Wrap long single-line shell commands in the approval prompt so the full command is always visible.
- Refactor file reference completion in the TUI.
- Load Kimi-specific user skills and global agent instructions from `KIMI_CODE_HOME` when set.

## 0.11.0 (2026-06-05)

### Features

- Add experimental sub-skill discovery, gated by `KIMI_CODE_EXPERIMENTAL_SUB_SKILL`. Ships with a `sub-skill` builtin package (`sub-skill.review`, `sub-skill.consolidate`) for inventorying skills and organizing them into hierarchical groups.
- Add the following environment variables:
  - `KIMI_MODEL_TEMPERATURE`, `KIMI_MODEL_TOP_P` — sampling parameters that apply globally to any `kimi` provider (not bound to `KIMI_MODEL_NAME`).
  - `KIMI_MODEL_THINKING_KEEP` — Moonshot preserved-thinking passthrough (`thinking.keep`), only injected when Thinking is on.
  - `KIMI_CODE_NO_AUTO_UPDATE` (old alias `KIMI_CLI_NO_AUTO_UPDATE`) — completely disable the update preflight (no check, no background install, no prompt).
- Display built-in skills as direct slash commands, grouped before external skill commands.

### Bug Fixes

- Fix slash command autocomplete submitting the target text when the cursor is before existing text.
- Fix queued goals being lost or duplicated when their promotion attempt fails.
- Fix pending goal queue handling when editing or pasting a queued goal.
- Ask before starting a goal in YOLO mode, so the user can switch to Auto for unattended work.
- Show a concise provider filter error when the response is intercepted before producing visible output.
- Show "unknown command" instead of "too many arguments" when entering an invalid subcommand.
- Cap `xhigh` and `max` thinking effort at `high` for OpenAI Chat Completions, unless the model supports `xhigh` on `v1/chat/completions`.
- Preserve thinking effort when compacting long conversations.
- Refresh provider model metadata when capabilities change but the model ID does not.

### Polish

- Use the same emphasis treatment for pending goal confirmation styling as goal lifecycle messages.
- Start a pending goal immediately when there is no active goal to wait for.
- Support multi-line editing when managing pending goals.
- Use a fixed 30-minute timeout for subagents, with a concise recovery hint after timeout.
- Highlight goal queue subcommands when typing a slash command.

## 0.10.1 (2026-06-05)

### Bug Fixes

- Fix a crash when starting a goal in the TUI.

## 0.10.0 (2026-06-04)

### Features

- Users can now prepare multiple goals for the agent to process one after another. When the current goal completes, the agent automatically picks the next one from the queue. Use `/goal next <objective>` to queue a goal, and `/goal next manage` to interactively view and modify the queue.
- Add a built-in `update-config` skill — you can now ask Kimi to edit its own config file.
- Add persisted experimental feature toggles, plus a TUI panel that applies the changes by reloading the current session after confirmation.
- Add `/reload` to reload the current session with updated config files, and `/reload-tui` to reload only TUI preferences.
- Add a doctor command to validate the Kimi Code config file.

### Bug Fixes

- Normalize malformed Responses throughput-limit errors into provider rate limit failures.
- Keep hosted OAuth credentials scoped to their configured auth and API endpoints.
- Prevent active and queued goals from being carried into forked sessions.
- Fail early on Windows when Git Bash is missing before starting a CLI session.
- Refresh the update target before showing the foreground update prompt, so the displayed version matches the installed version.
- Point session error diagnostics to the `/export-debug-zip` command.
- Stop renaming the running process when setting the terminal tab title.

### Polish

- Start the automatic background update immediately once the startup check finds a new version.
- Set the CLI process title to `kimi-code` during startup.
- Lowercase stale file content hints in edit tool errors.

### Refactors

- Ensure the Nix-packaged CLI build can find ripgrep and fd.

### Other

- Add the Git Bash prerequisite to the Windows installation guide.

## 0.9.0 (2026-06-03)

### Features

- Support `kimi acp` subcommand: kimi-code now speaks the [Agent Client Protocol 0.23](https://agentclientprotocol.com/) over stdio, so IDEs (Zed, JetBrains AI Chat, custom clients) can drive sessions directly; coverage matrix, Zed configuration, and breaking pre-release notes are on the [kimi acp subcommand page](https://moonshotai.github.io/kimi-code/zh/reference/kimi-acp.html).
- Add `/btw` for side-channel conversations that do not steer the main turn, and allow `/btw` to open the side-channel panel before entering a question.

### Bug Fixes

- Fix the external editor (Ctrl+G) on Windows by removing the dependency on `/bin/sh` and using platform-aware shell quoting for temporary file paths.
- Use the OpenAI completion token field required by newer Chat Completions models.
- Use the configured model output cap as the completion token cap.
- Fix the goal budget tool schema for OpenAI-compatible providers.
- Lazily resume saved subagents only when they are accessed.

### Polish

- Unify TUI dialog and picker interaction and visuals.
- Log enabled experimental flags at startup.

### Refactors

- Allow SDK runtime instances to use a separate RPC client while preserving the local CLI startup flow.

## 0.8.0 (2026-06-02)

### Features

- Add experimental goal mode for longer tasks spanning multiple turns. Set `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1` before starting Kimi to enable it.
  Use `/goal <objective>` in the terminal interface to have Kimi focus on the same task across turns. For example:
  ```text
  /goal Fix the failing checkout test
  ```
  Kimi will show the goal in the terminal interface and keep progress visible as it works. Use `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel`, and `/goal replace <objective>` to manage the goal. This feature is still experimental — feedback is welcome.
- Add `kimi provider` CLI subcommand supporting `add`, `remove`, `list`, and `catalog list` / `catalog add` operations to import and manage providers from custom registries (api.json) or the public models.dev catalog without starting the terminal interface.
- Add background structured questions, letting the agent continue working while waiting for the user's answer.
- Add background automatic updates, disableable in tui.toml.
- Add `/undo` slash command to retract the last prompt from the conversation history, keeping the replay log in sync on undo.
- Add `kimi upgrade` command to manually check for and upgrade Kimi Code CLI.
- Add approval lifecycle hook events for observing pending and completed permission prompts.
- Allow subagents to use custom tools registered on their parent agent.
- Support searching explicit absolute paths (outside the workspace) with glob.

### Bug Fixes

- Fix the edit preview tool showing an empty diff by always providing a contiguous context window.
- Fix duplicate tool call IDs by regenerating them for each model request.
- Fix task output not being available when the task exits before the agent reads it.
- Fix the read tool not handling UTF-8 text files containing NUL bytes.
- Fix the web search tool fetching the same URL twice.
- Fix the agent getting stuck in an infinite loop when the tool result is rejected by the model.

### Polish

- Add a one-line status message before calling important tools, shown in the user's current language.
- Show a line count summary in the edit tool result so the agent knows how many lines were changed.
- Improve the agent's ability to describe the current working directory and its contents.

## 0.7.0 (2026-06-01)

### Features

- Add the `kimi doctor` command to validate the Kimi Code configuration file.
- Add the `kimi export` command to export a session as a portable JSON file.
- Add support for the Claude 4 Opus model.

### Bug Fixes

- Fix the TUI crashing when the terminal is resized to a very small width.
- Fix the agent not being able to read files outside the workspace when the workspace is a symlink.
- Fix the agent getting stuck in an infinite loop when the tool result is rejected by the model.

### Polish

- Improve the agent's ability to describe the current working directory and its contents.
- Show a line count summary in the edit tool result so the agent knows how many lines were changed.

## 0.6.0 (2026-05-31)

### Features

- Add the `kimi -p` (print/prompt) mode for non-interactive use.
- Add the `kimi -y` (YOLO) mode for fully automatic operation.
- Add the `kimi --plan` mode for planning before execution.
- Add the `kimi --continue` flag to resume the last session.
- Add the `kimi --model` flag to select a model at startup.
- Add the `kimi --session` flag to resume a specific session.

### Bug Fixes

- Fix the TUI not rendering correctly on Windows Terminal.
- Fix the agent not being able to read files outside the workspace.

## 0.5.0 (2026-05-30)

### Features

- Initial release of Kimi Code CLI.
- Basic TUI with conversation transcript, input box, and slash commands.
- Support for multiple LLM providers (Anthropic, OpenAI, Kimi, Google Gemini).
- MCP server integration.
- Subagent support (coder, explore, plan).
- Session management (create, resume, list, fork, archive).
- Plugin system with marketplace.
- Skill system with built-in and custom skills.
- Goal mode for multi-turn tasks.
- Plan mode for planning before execution.
- Swarm mode for parallel subagent execution.
- Background tasks and cron jobs.
- i18n support (English and Chinese).
- Custom themes and color schemes.
- OAuth authentication.
- Telemetry and usage tracking.
- Automatic updates.
