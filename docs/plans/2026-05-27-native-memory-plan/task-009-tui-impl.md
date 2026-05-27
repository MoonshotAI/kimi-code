# Task 009 impl — Session API + RPC + SDK + MemoryBrowserApp + slash registry

**Subject**: Wire `/memory` and `/remember` end-to-end from TUI through SDK/RPC to agent-core.
**Type**: impl
**Depends-on**: ["009-test", "002-impl", "003-impl", "005-impl"]

## BDD Scenarios

```gherkin
Feature: /memory slash command (TUI curation)

  Scenario: /memory opens a list grouped by scope
    Given facts exist in both scopes
    When the user types "/memory"
    Then the TUI mounts a full-screen browser
    And the panel groups facts under "Project" and "User" headers
    And each row shows slug, type, and one-line description

  Scenario: Selecting a fact previews its body read-only
    Given the /memory panel is open
    When the user selects fact "code-style"
    Then a read-only pane displays the full body including frontmatter
    And no edit affordance is exposed in this view

  Scenario: Deleting via the UI requires explicit confirmation
    Given the /memory panel is open and a fact is selected
    When the user presses "d"
    Then a confirmation prompt is shown
    And only after explicit confirmation is the delete dispatched through `session.deleteMemory(...)`
    And the deletion is atomic at the body file level

  Scenario: /memory shows shadowed user-scope facts with an indicator
    Given the user scope and project scope each contain a fact with slug "code-style"
    When the user opens "/memory"
    Then both facts are listed
    And the user-scope entry is annotated as "shadowed by project"

  Scenario: /remember triggers an agent-routed write (not a direct file write)
    When the user types "/remember Use pnpm not npm in this repo"
    Then `session.remember("Use pnpm not npm in this repo")` is invoked
    And a subagent is spawned to call the Memory tool with operation "write"
    And the TUI does not touch any memory file directly

  Scenario: /remember reuses the /init queueing pattern
    Given the editor has pending user messages
    When the user types "/remember <text>"
    Then deferred-message queueing matches the pattern used by /init
    And the spinner resets after the subagent completes
```

## Files

### agent-core
- **Modify**: `packages/agent-core/src/session/index.ts` — add `listMemory(): Promise<readonly MemoryEntry[]>`, `deleteMemory(scope, slug): Promise<boolean>`, `remember(text): Promise<void>`. `remember` mirrors `generateAgentsMd` at lines 252-280 (spawn `coder` subagent with a synthesized prompt; append a `'memory'`-variant system reminder on completion).
- **Modify**: `packages/agent-core/src/rpc/core-api.ts` + `core-impl.ts` + `session/rpc.ts` — RPC entries for `listMemory` / `deleteMemory` / `remember` (mirror `generateAgentsMd` plumbing).

### node-sdk
- **Modify**: `packages/node-sdk/src/session.ts` — `listMemory()`, `deleteMemory(scope, slug)`, `remember(text)` SDK wrappers.

### TUI
- **Create**: `apps/kimi-code/src/tui/memory/browser.ts` — `MemoryBrowserApp` class (full-screen panel; mirrors `TasksBrowserApp` at `kimi-tui.ts:4552-4620`).
- **Create**: `apps/kimi-code/src/tui/memory/state.ts` — browser UI state (selected scope filter, focused slug, confirm-delete mode).
- **Modify**: `apps/kimi-code/src/tui/commands/registry.ts` — add `{ name: 'memory', aliases: [], description: 'Browse and manage stored memory', priority: 70 }` and `{ name: 'remember', aliases: [], description: 'Ask the agent to remember something', priority: 80 }`.
- **Modify**: `apps/kimi-code/src/tui/kimi-tui.ts` — add `case 'memory':` and `case 'remember':` to the slash dispatch (~line 1586); implement `handleMemoryCommand` (mount the browser via alt-screen takeover) and `handleRememberCommand` (mirror `handleInitCommand` queueing flow, calling `session.remember(text)`).

## Implementation guidance

`Session.remember(text)` prompt template:
```
The user asked you to remember the following:

<text>

Pick an appropriate kebab-case `name` (slug), a one-line `description` (≤ 240 chars),
a `type` from {user, feedback, project, reference}, and a `scope` from {user, project}
(prefer `project` if the fact is repo-specific, `user` if it follows the user
across all projects). Call the Memory tool with `operation: "write"` to persist
the fact. If a similar slug already exists, use `operation: "update"` instead.
```

`MemoryBrowserApp` keybindings: `↑/↓` navigate, `Enter` toggle detail, `d` open delete-confirm, `s` cycle scope filter (`all`/`user`/`project`), `Esc`/`q` close.

`handleMemoryCommand`:
1. `entries = await session.listMemory()`.
2. Mount `MemoryBrowserApp` as alt-screen takeover (save children, `state.ui.clear()`, `addChild(browser)`).
3. Browser dispatches `delete` via `session.deleteMemory(scope, slug)`.
4. On `Esc`/`q`, unmount and restore.

`handleRememberCommand` (`args` is the text after `/remember `):
1. Guard: model set, session exists.
2. `this.deferUserMessages = true; this.beginSessionRequest();`
3. `await session.remember(args);`
4. `this.track('remember_complete');`
5. `this.finalizeTurn((item) => this.sendQueuedMessage(session, item));`
6. Same error handling as `handleInitCommand` (`isAbortError` reset path).

## Verification

- `pnpm test apps/kimi-code/test/tui/memory-browser.test.ts` — all browser tests pass.
- `pnpm test packages/agent-core/test/session` — session API tests pass.
- Manual smoke: `pnpm dev:cli`, run `/memory`, write a fact via `/remember`, browse, delete with confirm.
- `pnpm typecheck` + `pnpm lint` pass.
