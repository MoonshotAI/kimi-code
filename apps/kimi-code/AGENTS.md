# apps/kimi-code Development Guide

This file only contains rules local to `apps/kimi-code`. For cross-repo rules, see the root `AGENTS.md`.

> **Writing or modifying the TUI?** Use the `write-tui` skill (`.agents/skills/write-tui/SKILL.md`). It covers the architecture orientation, where new features go, test placement, theme mechanics, and the dialog interaction/visual spec (`DESIGN.md`). This file keeps only the map, boundaries, and hard constraints.

## TUI File Layout

`apps/kimi-code` is the terminal UI / CLI app. The entry chain is:

`src/main.ts` -> `src/cli/commands.ts` -> `src/cli/run-shell.ts` -> SDK `KimiHarness` -> `src/tui/kimi-tui.ts`

Main directories:

- `src/constant/`: non-copy constants shared by CLI/TUI — product, protocol, paths, terminal control, updates, and so on.
- `src/cli/`: command-line arguments, subcommands, and CLI startup.
- `src/tui/`: the interactive terminal UI.
- `src/tui/kimi-tui.ts`: the `KimiTUI` coordinator — wires state, layout, editor, session, SDK events, and dialogs together, and dispatches slash-command handlers. Heavy logic is delegated to `controllers/`, not accumulated here.
- `src/tui/tui-state.ts`: `TUIState`, `createTUIState`, `createInitialAppState` — the single global UI-state shape.
- `src/tui/controllers/`: independently-testable responsibilities — `session-event-handler` (SDK event routing), `streaming-ui` (streaming render), `session-replay` (resume/replay), `tasks-browser`, `editor-keyboard`, `auth-flow`.
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
- `src/tui/theme/`: themes, color tokens, style helpers, terminal-background detection, and the pi-tui markdown theme.
- `src/tui/utils/`: TUI-only utility functions.
- `src/utils/`: app-wide utilities — clipboard, git, history, image, process, usage, and so on.

## Module Responsibilities

- `cli` only interprets command-line input, assembles startup arguments, and invokes the TUI. Do not put TUI interaction logic into the CLI.
- `KimiTUI` coordinates; it does not accumulate complex business rules. New logic that can be tested independently should be split into `controllers`, `commands`, `components`, `reverse-rpc`, or `utils` first.
- `controllers` own the heavy, independently-testable slices (event routing, streaming render, session replay, tasks browser, editor keyboard, auth). Event-routing and rendering logic belong here, not on the `KimiTUI` class.
- `commands` only owns slash-command declaration, parsing, and the parsed-result types. The actual execution can be dispatched from `KimiTUI`, but complex logic should continue to sink downward.
- `components` only handle presentation and local interaction; they must not call the SDK directly, and must not read or write session state directly.
- `reverse-rpc` converts SDK approval/question requests into the data shape a UI panel/dialog needs, and converts the user's choice back into an SDK response.
- `theme` is the single source of truth for colors and styles. Components must not bypass the theme system and use chalk named colors directly.
- `utils` holds utility functions with no UI-state dependency. Logic that needs `TUIState` or a component instance must not live under app-level `src/utils`.
- `apps/kimi-code` may only use core capabilities through `@moonshot-ai/kimi-code-sdk`. Do not import `@moonshot-ai/agent-core` directly in app code.

## TUI Coding Conventions

- Do not over-encapsulate, especially for one- or two-line functions — do not introduce a two-layer wrapper, just inline.
- Functions with no state / UI side effects do not belong as private methods on the `KimiTUI` class; put them in external utils.
- Constants must live in the corresponding `constant` directory; they must not be scattered through component or logic code.
- Inside `handleInput(data)`, when comparing a printable character (letter, digit, space, punctuation), it is **forbidden** to write literal comparisons such as `data === 'q'`. With the Kitty keyboard protocol enabled in terminals like VSCode, these keys are sent as CSI-u sequences (e.g. `\x1b[113u`), and a bare comparison will never match. Decode with `printableChar(data)` from `src/tui/utils/printable-key.ts` first, then compare; function keys continue to use `matchesKey(data, Key.*)`; control characters (codepoint < 32) may still be compared against the raw `data`. `test/tui/printable-key-guard.test.ts` enforces this in CI.

## Color Rules (normative)

The theme apply/switch mechanics live in the `write-tui` skill. The following rules are hard and guard-enforced:

- Do not use chalk named colors such as `chalk.red`, `chalk.cyan`, `chalk.white`, `chalk.gray`, `chalk.dim`, or `chalk.yellow` directly.
- If a component already has `colors`, use `chalk.hex(colors.<token>)(text)`.
- If a component already has `state.theme.styles` or styles passed in, prefer helpers such as `styles.error(text)`, `styles.dim(text)`.
- When new visual semantics have no token, first add a semantic field to `ColorPalette`, and fill in both `darkColors` and `lightColors`.
- In light themes, text tokens against a white background must be at least 4.5:1; borders and large chrome must be at least 3:1.
- Do not cache styled chalk functions at module top level. Theme switching must take effect within a single render, so styles must be generated on the render path from the current palette.
- Non-comment code must not contain chalk named colors such as `chalk.white`, `chalk.cyan`, `chalk.red`, `chalk.green`, `chalk.gray`, `chalk.yellow`, `chalk.blue`, `chalk.magenta`, `chalk.whiteBright`, or `chalk.blackBright`. `test/tui/chalk-named-color-guard.test.ts` enforces this in CI.

## General Coding Requirements

- For optional object properties, pass `undefined` directly — do not use conditional spread.
- Optional object properties do not need to additionally allow `undefined` in the type.
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's own `index.ts`, other `index.ts` files should prefer `export * from './module'`.
