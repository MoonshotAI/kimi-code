---
name: write-tui
description: Use when writing or modifying the kimi-code terminal UI in apps/kimi-code/src/tui — components, dialogs/selectors, slash commands, themes, streaming render, or the KimiTUI controllers. Covers the architecture, where new features go, test placement, the theme system mechanics, and the dialog interaction/visual spec (DESIGN.md).
---

# Write TUI (apps/kimi-code)

The terminal UI lives in `apps/kimi-code/src/tui`. Before writing TUI code, read `apps/kimi-code/AGENTS.md` for the always-on **map, module boundaries, and hard constraints** (printable-key decoding, no chalk named colors, etc.). This skill is the **how-to**: architecture orientation, feature routing, test placement, theme mechanics, and the dialog spec.

For any list dialog, selector, input box, or status/toggle list, the interaction and visual rules are normative — see **[DESIGN.md](./DESIGN.md)** in this folder and follow its self-check list before submitting.

## Architecture

`KimiTUI` is a **coordinator** that wires state, layout, session, and dialogs together and delegates heavy logic to controllers.

- `src/tui/kimi-tui.ts` — the `KimiTUI` coordinator. Holds `state`, owns startup/shutdown order, layout/editor wiring, user-input entry, sending/queueing, session lifecycle, and the slash-command handler dispatch. It should **not** accumulate event-routing or rendering logic — those live in controllers.
- `src/tui/tui-state.ts` — `TUIState`, `createTUIState`, `createInitialAppState`. The single global UI state shape. Before adding a new global field, decide whether it truly belongs here vs. local component state.
- `src/tui/controllers/` — the independently-testable responsibilities. Each controller owns one slice:
  - `session-event-handler.ts` — routes SDK session events (`handleEvent` dispatch + the per-event `handleXxx`). Concrete event handling goes here, not in `KimiTUI`.
  - `streaming-ui.ts` — streaming render: assistant delta, thinking, tool call / result, compaction, subagent, background agent, transcript aggregation.
  - `session-replay.ts` — resume/replay orchestration; drives replay records through the same live render hooks. Stateless replay parsing/limiting/projection helpers belong in `src/tui/utils/message-replay.ts`.
  - `tasks-browser.ts` — the tasks browser controller.
  - `editor-keyboard.ts` — editor keyboard handling, exit shortcuts, external editor, clipboard image.
  - `auth-flow.ts` — login/auth orchestration (`refreshConfigAfterLogin`, etc.).
- `src/tui/commands/` — slash-command declaration, parsing, ordering, and dynamic skill-command generation. Parsing and types only; execution is dispatched from `KimiTUI`'s slash-command handler section, and complex execution sinks into `utils` or focused components.
- `src/tui/components/` — pi-tui components by UI type: `chrome/` (footer, todo, welcome, loader, device code), `dialogs/` (selectors, approval/question panels, settings popups that replace the editor), `editor/` (input box + mention provider), `media/` (image, diff, code highlight), `messages/` (transcript blocks + tool-renderers), `panes/` (activity, queue).
- `src/tui/reverse-rpc/` — adapts SDK approval/question callbacks into UI panel data and the user's choice back into an SDK response.
- `src/tui/theme/` — themes, color tokens, style helpers, pi-tui markdown theme, terminal-background detection. The single source of truth for color.
- `src/tui/utils/` — TUI-only utilities (need `TUIState` or a component). App-wide, UI-independent helpers go in `src/utils/`.

When a controller or `KimiTUI` section keeps growing, split pure functions, state projections, and presentation components into the matching directory rather than expanding the file.

## Where new features go

The feature type decides the landing spot:

- **CLI arguments** → `src/cli/commands.ts` / `src/cli/options.ts`, passed into the TUI via `src/cli/run-shell.ts`. The CLI never operates on the session directly.
- **CLI subcommands** → `src/cli/sub/`, non-interactive only; reach core via `@moonshot-ai/kimi-code-sdk`.
- **Slash commands** → declare/parse/type under `src/tui/commands/`; add the execution entry in `KimiTUI`'s slash-command handler section; sink complex logic into `utils` or a focused component.
- **Skill-derived commands** → hook into `buildSkillSlashCommands` / the skill command map; do not hard-code a single skill.
- **Transcript message types** → define the shape in `src/tui/types.ts`, add/extend a `components/messages/` component, register the renderer in the transcript builder.
- **Tool-result display** → extend `components/messages/tool-renderers/registry.ts` and the renderer; do not stack branches inside `ToolCallComponent`.
- **Popup / selector** → `components/dialogs/`, mounted via `mountEditorReplacement`; follow [DESIGN.md](./DESIGN.md). If triggered by an SDK callback, check whether `reverse-rpc/` needs an adapter/controller/handler.
- **SDK event handling** → add the dispatch in `session-event-handler.ts`'s `handleEvent`, then the matching `handleXxx`.
- **Streaming render** → `controllers/streaming-ui.ts`.
- **Session start / resume behavior** → the session-management section of `KimiTUI`; replay behavior → `controllers/session-replay.ts`, reusing live render paths.
- **Status bar / activity / queue** → `chrome/footer`, `panes/activity`, `panes/queue`, and the matching `updateXxx`.
- **Configuration option** → read/write + schema in `src/tui/config.ts`, then the settings UI; persist through `saveTuiConfig` (a component never writes the config file itself).
- **Constants** → shared CLI/TUI non-copy constants in `src/constant/`; TUI-only non-copy constants in `src/tui/constant/`. Component-local copy, option labels, help text, dialog titles/footers stay next to their component — do not centralize copy into a global module.
- **General capability** → no TUI-state dependency → `src/utils/`; depends on TUI state or a component → `src/tui/utils/`.

## Test placement

- Component behavior tests sit next to the component's existing tests (`test/tui/components/...`).
- Command parsing tests → `test/tui/commands/`.
- reverse-rpc tests → `test/tui/reverse-rpc/`.
- Pure utility tests → next to the corresponding utils tests.
- Do not create a generic `some-feature.test.ts` just to land a small feature; extend the nearest existing test file.

## Theme system mechanics

Themes are managed centrally under `src/tui/theme/`:

- `colors.ts` — semantic tokens: `ColorPalette`, `darkColors`, `lightColors`.
- `styles.ts` — common chalk helpers built on top of `ColorPalette`.
- `pi-tui-theme.ts` — the markdown/pi-tui theme config.
- `terminal-background.ts` — terminal background detection used by auto resolution.
- `bundle.ts` — packs `colors`, `styles`, `markdownTheme` into a `KimiTUIThemeBundle`.
- `index.ts` / `detect.ts` — theme type and auto/dark/light resolution.

Apply / switch flow:

- UI entry: `ThemeSelectorComponent` → `handleThemeCommand` → `applyThemeChoice`.
- The real apply step is `KimiTUI.applyTheme`: it updates `state.theme`, `state.appState.theme`, and notifies components to refresh their palette.
- Persist the choice through `saveTuiConfig` — a component must not write the config file itself.

> The **hard color rules** (no chalk named colors, contrast ratios, no module-top-level cached styled functions, add a `ColorPalette` token before inventing a color) are normative and guard-enforced — they live in `apps/kimi-code/AGENTS.md`. This skill only covers the mechanics.

## Before you submit

- Run lint / format / test on the files you changed.
- For any dialog/selector/input/toggle list, walk the self-check list at the end of [DESIGN.md](./DESIGN.md).
- Keep `printableChar()` for printable-key comparisons (CI guard) and `chalk.hex(colors.<token>)` for color (CI guard).
