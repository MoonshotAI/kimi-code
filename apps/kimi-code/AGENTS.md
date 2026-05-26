# apps/kimi-code Development Guide

This file only contains rules local to `apps/kimi-code`. For cross-repo rules, see the root `AGENTS.md`.

## TUI File Layout

`apps/kimi-code` is the terminal UI / CLI app. The entry chain is:

`src/main.ts` -> `src/cli/commands.ts` -> `src/cli/run-shell.ts` -> SDK `KimiHarness` -> `src/tui/kimi-tui.ts`

Main directories:

- `src/constant/`: non-copy constants shared by CLI/TUI — product, protocol, paths, terminal control, updates, and so on.
- `src/cli/`: command-line arguments, subcommands, and CLI startup.
- `src/tui/`: the interactive terminal UI.
- `src/tui/kimi-tui.ts`: the TUI master assembler, responsible for wiring state, layout, editor, session, SDK events, and dialogs together.
- `src/tui/commands/`: slash command definitions, parsing, ordering, and dynamic skill command generation.
- `src/tui/components/`: pi-tui components, organized by UI type.
- `src/tui/constant/`: non-copy constants reused across TUI modules — symbols, terminal sequences, render sizing, streaming-arg match rules, and so on.
- `src/tui/components/chrome/`: persistent UI chrome — footer, todo panel, welcome, loader, device code.
- `src/tui/components/dialogs/`: selectors, approval panels, question popups, and settings popups that temporarily replace the editor.
- `src/tui/components/editor/`: the custom input box and the file mention provider.
- `src/tui/components/media/`: image, diff, code highlight, and other media displays.
- `src/tui/components/messages/`: message blocks in the transcript — assistant, user, tool call, thinking, usage, subagent, and so on.
- `src/tui/components/panes/`: right-side / activity-area panes such as the activity pane and queue pane.
- `src/tui/reverse-rpc/`: the adapter layer that bridges SDK approval/question callbacks to the UI.
- `src/tui/theme/`: themes, color tokens, style helpers, and the pi-tui markdown theme.
- `src/tui/utils/`: TUI-only utility functions.
- `src/utils/`: app-wide utilities — clipboard, git, history, image, process, usage, and so on.

## Module Responsibilities

- `cli` only interprets command-line input, assembles startup arguments, and invokes the TUI. Do not put TUI interaction logic into the CLI.
- `KimiTUI` coordinates; it does not accumulate complex business rules. New logic that can be tested independently should be split into `commands`, `components`, `reverse-rpc`, or `utils` first.
- `commands` only owns slash-command declaration, parsing, and the parsed-result types. The actual execution can be dispatched from `KimiTUI`, but complex logic should continue to sink downward.
- `components` only handle presentation and local interaction; they must not call the SDK directly, and must not read or write session state directly.
- `reverse-rpc` converts SDK approval/question requests into the data shape a UI panel/dialog needs, and converts the user's choice back into an SDK response.
- `theme` is the single source of truth for colors and styles. Components must not bypass the theme system and use chalk named colors directly.
- `utils` holds utility functions with no UI-state dependency. Logic that needs `TUIState` or a component instance must not live under app-level `src/utils`.
- Resume replay orchestration lives in the `Session Replay` section of `KimiTUI`, because it intentionally drives the same stateful render hooks as live events. Stateless replay parsing, limiting, and projection helpers belong in `src/tui/utils/message-replay.ts`.
- `apps/kimi-code` may only use core capabilities through `@moonshot-ai/kimi-code-sdk`. Do not import `@moonshot-ai/agent-core` directly in app code.

## KimiTUI Internal Sections

`src/tui/kimi-tui.ts` is large. When you modify it, place code into the existing responsibility section — do not just drop it where it happens to be convenient.

- Types and state creation: `KimiTUIStartupInput`, `TUIState`, `createInitialAppState`, `createTUIState`. Before adding new global UI state, decide whether it really belongs in `TUIState`.
- Startup helpers: slash commands, autocomplete, skill commands, input history.
- Lifecycle: `start`, `init`, `stop`. They only handle startup/shutdown order — do not stuff feature implementations into them.
- Layout and editor: `buildLayout`, `setupEditorHandlers`, external editor, clipboard image, exit shortcuts.
- User input: `handleUserInput`, `executeSlashCommand`, `handleBuiltInSlashCommand`, `sendNormalUserInput`.
- Sending and queueing: `enqueueMessage`, `sendMessageInternal`, `sendMessage`, `steerMessage`, `finalizeTurn`.
- Session management: create, restore, switch, close, sync runtime state, subscribe to session events.
- Session replay: hydrate resume snapshots, drive replay records through live render hooks, and clean up transient replay state.
- Event routing: `handleEvent` only dispatches; concrete events go into the corresponding `handleXxx`.
- Streaming rendering: assistant delta, thinking, tool call, tool result, compaction, subagent, background agent.
- Transcript: `createTranscriptComponent`, `appendTranscriptEntry`, read/tool/agent group aggregation.
- Activity / queue / footer: `updateActivityPane`, `resolveActivityPaneMode`, `updateQueueDisplay`, terminal progress.
- Dialogs / selectors: help, session picker, editor/model/thinking/theme/permission/settings selectors, approval / question panels.
- Slash command handlers: `handleThemeCommand`, `handleModelCommand`, `handlePlanCommand`, `handleCompactCommand`, `handleLoginCommand`, and so on.

If a section keeps growing, split pure functions, state projections, presentation components, and handler logic into the corresponding directories rather than continuing to expand `KimiTUI`.

## Where New Features Go

The feature type decides where it lands:

- New CLI arguments: change `src/cli/commands.ts` / `src/cli/options.ts`, then pass them into the TUI via `src/cli/run-shell.ts`. Do not let the CLI operate on the session directly.
- New CLI subcommands: put them under `src/cli/sub/`, with non-interactive command logic only; when SDK access is needed, go through `@moonshot-ai/kimi-code-sdk`.
- New slash commands: first change definition, parsing, and types under `src/tui/commands/`; put the execution entry into the slash-command handler section of `KimiTUI`; split complex execution logic into `utils` or focused components when it has no reason to stay in `KimiTUI`.
- New skill-derived commands: hook into `buildSkillSlashCommands` / the skill command map — do not hard-code a single skill.
- New transcript message types: define the data shape in `src/tui/types.ts`, add or extend a component under `components/messages/`, and register the renderer in `createTranscriptComponent`.
- New tool-result display: prefer extending `components/messages/tool-renderers/registry.ts` and the corresponding renderer; do not stack branches inside `ToolCallComponent`.
- New popup / selector: put it under `components/dialogs/` and mount it via `mountEditorReplacement`; if the trigger comes from an SDK callback, also check whether `reverse-rpc/` needs an adapter/controller/handler.
- New SDK event handling: add the dispatch in `handleEvent`, then add the corresponding `handleXxx`. If the event simply maps to a transcript entry.
- New session start / resume behavior: put it in the session management section, keeping `init` focused only on startup orchestration. New resume replay behavior belongs in the `Session Replay` section and should reuse live rendering paths where possible.
- New status bar, activity area, or queue display: change `chrome/footer`, `panes/activity`, `panes/queue`, and the corresponding `updateXxx` method.
- New configuration option: first change the read/write and schema in `src/tui/config.ts`, then wire the settings UI; when persistence is needed, go through `saveTuiConfig`.
- New constants: constants shared by CLI/TUI and not copy belong in `src/constant/`; non-copy constants reused only within the TUI belong in `src/tui/constant/`. Component-local copy, option labels, help descriptions, dialog title/footer text — keep these next to the corresponding component or command, do not centralize them into a global copy constants module.
- New general-purpose capability: if it does not depend on TUI state, put it under `src/utils/`; if it depends on TUI state or a component, put it under `src/tui/utils/`.

Test placement rules:

- Component behavior tests live next to the corresponding component's tests.
- Command parsing tests go under `test/tui/commands/`.
- reverse-rpc tests go under `test/tui/reverse-rpc/`.
- Pure utility tests go next to the corresponding utils tests.
- Do not create a generic `some-feature.test.ts` just to land a small feature.

## TUI Coding Conventions

- Do not over-encapsulate, especially for one- or two-line functions — do not introduce a two-layer wrapper, just inline.
- Functions with no state / UI side effects do not belong as private methods on the `KimiTUI` class; put them in external utils.
- Constants must live in the corresponding `constant` directory; they must not be scattered through component or logic code.
- Inside `handleInput(data)`, when comparing a printable character (letter, digit, space, punctuation), it is **forbidden** to write literal comparisons such as `data === 'q'`. With the Kitty keyboard protocol enabled in terminals like VSCode, these keys are sent as CSI-u sequences (e.g. `\x1b[113u`), and a bare comparison will never match. Decode with `printableChar(data)` from `src/tui/utils/printable-key.ts` first, then compare; function keys continue to use `matchesKey(data, Key.*)`; control characters (codepoint < 32) may still be compared against the raw `data`. `test/tui/printable-key-guard.test.ts` enforces this in CI.

## How to Set Themes

Themes are managed centrally under `src/tui/theme/`:

- `colors.ts` defines semantic tokens: `ColorPalette`, `darkColors`, `lightColors`.
- `styles.ts` builds common chalk helpers on top of `ColorPalette`.
- `pi-tui-theme.ts` produces the theme configuration markdown / pi-tui requires.
- `bundle.ts` packs `colors`, `styles`, and `markdownTheme` into a `KimiTUIThemeBundle`.
- `index.ts` / `detect.ts` handle the theme type and auto/dark/light resolution.

When setting or switching themes:

- The UI entry goes through `ThemeSelectorComponent`, `handleThemeCommand`, and `applyThemeChoice`.
- The real apply step goes through `KimiTUI.applyTheme`, which should update `state.theme`, `state.appState.theme`, and notify the relevant components to refresh their palette.
- Persisting the user's choice goes through `saveTuiConfig`. Do not let a component write the config file itself.

When writing color:

- Do not use chalk named colors such as `chalk.red`, `chalk.cyan`, `chalk.white`, `chalk.gray`, `chalk.dim`, or `chalk.yellow` directly.
- If a component already has `colors`, use `chalk.hex(colors.<token>)(text)`.
- If a component already has `state.theme.styles` or styles passed in, prefer helpers such as `styles.error(text)`, `styles.dim(text)`.
- When new visual semantics have no token, first add a semantic field to `ColorPalette`, and fill in both `darkColors` and `lightColors`.
- In light themes, text tokens against a white background must be at least 4.5:1; borders and large chrome must be at least 3:1.
- Do not cache styled chalk functions at module top level. Theme switching must take effect within a single render, so styles must be generated on the render path from the current palette.

After a theme change, non-comment code must not contain chalk named colors such as `chalk.white`, `chalk.cyan`, `chalk.red`, `chalk.green`, `chalk.gray`, `chalk.yellow`, `chalk.blue`, `chalk.magenta`, `chalk.whiteBright`, or `chalk.blackBright`.

## General Coding Requirements

- For optional object properties, pass `undefined` directly — do not use conditional spread.
- Optional object properties do not need to additionally allow `undefined` in the type.
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's own `index.ts`, other `index.ts` files should prefer `export * from './module'`.
