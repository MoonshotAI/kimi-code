# Batch 5 Sprint Contract

**Plan**: `docs/plans/2026-05-27-native-memory-plan/`
**Batch scope**: One Red-Green pair — `/memory` (TUI curation browser) + `/remember <text>` (agent-routed write).
  - Pair: Tasks 16 + 17
**Execution mode**: Single Red-Green pair. Tests first (RED), then impl (GREEN).
**Revision**: 1

## Tasks

| ID (TaskList) | Plan ID | Subject | Type |
|---|---|---|---|
| 16 | 009-test | Tests for /memory (TUI browser) + /remember (session API) | test |
| 17 | 009-impl | Implement Session API + RPC + SDK + MemoryBrowserApp + slash registry + dispatch | impl |

## Acceptance Criteria

From `task-009-tui-test.md` (6 scenarios):

- [ ] **/memory opens a list grouped by scope**: TUI mounts a full-screen browser; facts grouped under "Project" and "User" headers; each row shows slug, type, one-line description.
- [ ] **Selecting a fact previews body read-only**: detail pane displays full body including frontmatter; no edit affordance exposed.
- [ ] **Deleting via UI requires explicit confirmation**: pressing `d` opens confirmation prompt; only after explicit confirmation is `session.deleteMemory(...)` dispatched; deletion is atomic at body-file level.
- [ ] **Shadowed user-scope facts annotated**: when both scopes hold the same slug, both facts listed; user-scope entry annotated as "shadowed by project".
- [ ] **/remember triggers agent-routed write**: `session.remember(text)` invoked; subagent spawned to call Memory tool with `operation: 'write'`; TUI does NOT touch any memory file directly.
- [ ] **/remember reuses /init queueing pattern**: deferred-message queueing matches `handleInitCommand`; spinner resets after the subagent completes.
- [ ] All 6 cases RED first, GREEN after impl.

## Implementation surface

### agent-core
- `packages/agent-core/src/session/index.ts` — add three Session methods:
  - `listMemory(): Promise<readonly MemoryEntry[]>` — returns merged user+project facts (calls `loadMemory` infra or constructs a `FileMemoryStore` and lists both scopes).
  - `deleteMemory(scope: MemoryScope, slug: string): Promise<boolean>` — calls `FileMemoryStore.delete`.
  - `remember(text: string): Promise<void>` — spawns a `coder` subagent (mirror `generateAgentsMd` at `session/index.ts:252-280`) with a synthesized prompt instructing it to call the Memory tool with `operation: 'write'`. On completion, append a `'memory'`-variant system reminder.

### RPC plumbing
- `packages/agent-core/src/rpc/core-api.ts` + `core-impl.ts` + `session/rpc.ts` — add `listMemory` / `deleteMemory` / `remember` RPC entries (mirror `generateAgentsMd` plumbing).

### node-sdk
- `packages/node-sdk/src/session.ts` — SDK wrappers for the three new methods.

### TUI (apps/kimi-code)
- `apps/kimi-code/src/tui/memory/browser.ts` (new) — `MemoryBrowserApp` class, full-screen panel. Mirror `TasksBrowserApp` at `kimi-tui.ts:4552-4620` for the alt-screen takeover + list+detail+confirm flow.
- `apps/kimi-code/src/tui/memory/state.ts` (new) — UI state: selected scope filter (`all`/`user`/`project`), focused slug, confirm-delete mode.
- `apps/kimi-code/src/tui/commands/registry.ts` — register two new commands:
  ```ts
  { name: 'memory',   aliases: [], description: 'Browse and manage stored memory',      priority: 70 },
  { name: 'remember', aliases: [], description: 'Ask the agent to remember something', priority: 80 },
  ```
- `apps/kimi-code/src/tui/kimi-tui.ts`:
  - Add `case 'memory':` and `case 'remember':` to the dispatch switch around line 1586.
  - Implement `private async handleMemoryCommand(args: string): Promise<void>` — mount the browser via alt-screen takeover (mirror `showTasksBrowser`).
  - Implement `private async handleRememberCommand(args: string): Promise<void>` — mirror `handleInitCommand` at `kimi-tui.ts:5601-5627`:
    - Guard: model set, session exists.
    - `this.deferUserMessages = true; this.beginSessionRequest();`
    - `await session.remember(args);`
    - `this.track('remember_complete');`
    - `this.finalizeTurn((item) => this.sendQueuedMessage(session, item));`
    - Same `isAbortError` reset path.

### Browser keybindings
- `↑/↓` navigate
- `Enter` toggle detail pane (read-only body view)
- `d` open delete-confirm
- `s` cycle scope filter (`all`/`user`/`project`)
- `Esc`/`q` close and restore editor

## Test files

- **Extend** an existing session-level test file (locate at execution time, e.g., `packages/agent-core/test/session/*.test.ts`) for the Session API tests. If none fits cleanly, add `packages/agent-core/test/session/memory.test.ts`.
- **Create** `apps/kimi-code/test/tui/memory-browser.test.ts` — `MemoryBrowserApp` rendering + interaction tests.
- **Extend or create** a kimi-tui slash-dispatch test for `/memory` and `/remember` registry + handler wiring. If no existing file fits, group with the new browser test file.

## Quality Requirements

- TypeScript style per repo `AGENTS.md`.
- `Session.remember` prompt template (per design `architecture.md` §5):
  ```
  The user asked you to remember the following:

  <text>

  Pick an appropriate kebab-case `name` (slug), a one-line `description` (≤ 240 chars),
  a `type` from {user, feedback, project, reference}, and a `scope` from {user, project}
  (prefer `project` if the fact is repo-specific, `user` if it follows the user
  across all projects). Call the Memory tool with `operation: "write"` to persist
  the fact. If a similar slug already exists, use `operation: "update"` instead.
  ```
- TUI browser does NOT touch memory files directly — all mutations go through `session.deleteMemory()` / `session.remember()`.
- Confirm-delete must be explicit (key + Enter), never on first keypress.
- No co-author / no agent identity / no emojis / no AI slop.

## Verification Commands

After all 2 tasks:

```bash
cd /Users/FradSer/Developer/FradSer/kimi-code
pnpm typecheck
pnpm exec vitest run packages/agent-core/test/session
pnpm exec vitest run packages/agent-core/test/tools/memory.test.ts
pnpm exec vitest run packages/agent-core/test/profile
pnpm exec vitest run packages/agent-core/test/skill
pnpm exec vitest run apps/kimi-code/test  # if browser tests added
pnpm lint packages/agent-core/src/session packages/node-sdk/src apps/kimi-code/src/tui/memory apps/kimi-code/src/tui/commands/registry.ts
```

All exit 0. Capture last 20 lines.

## Out of scope

- Final `memory.md` tool description text — Batch 6 (Task 20).
- Final reference doc and changeset — Batch 6 (Task 20).

## Sign-off

Revision: 1
Written by: executing-plans main agent
Date: 2026-05-28
