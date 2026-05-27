# Task 009 test — /memory (TUI browser) + /remember (agent-routed write) + session API

**Subject**: Tests for `Session.listMemory` / `deleteMemory` / `remember`, RPC plumbing, and the `MemoryBrowserApp` TUI.
**Type**: test
**Depends-on**: ["001"]

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

- **Extend** an existing session-level test file (locate at execution time, e.g. `packages/agent-core/test/session/*.test.ts`) for `Session.listMemory` / `deleteMemory` / `remember`. If none fits, create `packages/agent-core/test/session/memory.test.ts`.
- **Create** `apps/kimi-code/test/tui/memory-browser.test.ts` — `MemoryBrowserApp` tests (list rendering, scope filter, delete-confirm flow).
- **Extend** any existing `kimi-tui` slash-dispatch tests for `/memory` and `/remember` registry + handler wiring. If none exists, add a focused integration test alongside `memory-browser.test.ts`.

## Implementation guidance

Session API tests:
- `listMemory()` returns entries from both scopes (calls `loadMemory` infra).
- `deleteMemory(scope, slug)` calls `FileMemoryStore.delete` and refreshes any in-memory cache.
- `remember(text)` spawns a subagent via `subagentHost.spawn('coder', { prompt: <synthesized>, ... })`. Assert: spawn invoked with a prompt containing the user text and an instruction to call the Memory tool with `operation: 'write'`. Mock `subagentHost.spawn` to capture the prompt.

Browser tests:
- List view rendering: scopes grouped, headings present, row format `slug (type) — description`.
- Detail pane: shows frontmatter + body; no edit input rendered.
- Delete confirm: pressing `d` opens a confirmation; pressing enter dispatches `session.deleteMemory(...)`; pressing escape cancels.
- Shadowed indicator: collision fixture; assert annotation string on the user-scope row.

`/remember` queueing:
- Spy on `deferUserMessages` / `beginSessionRequest` / `sendQueuedMessage`. Assert the call order matches `handleInitCommand`'s.

## Verification

- All new TUI + session tests FAIL initially.
- After 009-impl: all pass.
