# Batch 2 Sprint Contract

**Plan**: `docs/plans/2026-05-27-native-memory-plan/`
**Batch scope**: Three Red-Green pairs covering the full Memory tool surface against `FileMemoryStore`:
  - Pair A: Write (Tasks 4 + 5)
  - Pair B: Read (Tasks 6 + 7)
  - Pair C: Update + Delete (Tasks 8 + 9)
**Execution mode**: Linear-of-pairs (pair A → pair B → pair C; within each pair, test FIRST then impl). All three pairs share the source files `packages/agent-core/src/tools/builtin/state/memory.ts` and `packages/agent-core/src/memory/store.ts`, so writes serialize.
**Revision**: 1

## Tasks

| ID (TaskList) | Plan ID | Subject | Type |
|---|---|---|---|
| 4 | 003-test | Tests for Agent writes via the Memory tool | test |
| 5 | 003-impl | Implement Memory tool write operation + FileMemoryStore.write | impl |
| 6 | 004-test | Tests for Agent reads via the Memory tool | test |
| 7 | 004-impl | Implement Memory tool view/list/read + FileMemoryStore.list/read | impl |
| 8 | 005-test | Tests for Agent updates and deletes via the Memory tool | test |
| 9 | 005-impl | Implement Memory tool update/delete + FileMemoryStore.update/delete | impl |

## Acceptance Criteria (auto-derived from BDD Then-clauses)

### Pair A — Writes (Tasks 4, 5)

From `task-003-memory-write-test.md` Gherkin (6 scenarios):

- [ ] **Agent creates a new fact**: body file created at the project-scope `<slug>.md` path; frontmatter matches supplied record; tool result confirms scope + slug.
- [ ] **Atomic write — tmp-rename**: body file appears via a tmp-rename sequence; no `.tmp-*` file remains after completion.
- [ ] **Duplicate slug rejected**: tool returns `isError: true` with reason `EXISTS`; message suggests `update`; existing file unmodified.
- [ ] **Body > 4 KB rejected**: tool returns `isError: true` with reason `BODY_TOO_LARGE`; message states the 4 KB limit; no file created.
- [ ] **Missing frontmatter field rejected**: tool returns `isError: true`; message lists missing field `type` and enum values `user/feedback/project/reference`.
- [ ] **Secret content warning**: write succeeds; tool result includes a warning naming the matched pattern category; wire log records category (no raw match).
- [ ] All 6 cases initially FAIL (RED). After impl, all 6 PASS (GREEN).
- [ ] Tests added to `packages/agent-core/test/tools/memory.test.ts` (new file).
- [ ] `MemoryTool` builtin registered in `packages/agent-core/src/agent/tool/index.ts` near `TodoListTool`.
- [ ] `MemoryTool` re-exported from `packages/agent-core/src/tools/builtin/index.ts`.
- [ ] `FileMemoryStore.write` no longer throws `not implemented`.

### Pair B — Reads (Tasks 6, 7)

From `task-004-memory-read-test.md` Gherkin (6 scenarios):

- [ ] **view returns merged index**: output lists both facts grouped by scope; each line shows slug/type/description (no body); fits within 8 KB budget.
- [ ] **list filters by type**: only `reference`-typed slugs returned.
- [ ] **list filters by scope**: only user-scope slugs returned.
- [ ] **list returns full untruncated set**: 200-fact fixture; budget-truncated injected index; `list scope=project` returns all 200.
- [ ] **read returns full body**: body content + frontmatter in output.
- [ ] **read of unknown slug**: `isError: true` with `NOT_FOUND`; message names slug + scope; suggests `list`.
- [ ] All 6 cases RED then GREEN.
- [ ] `FileMemoryStore.list` and `.read` implemented.
- [ ] Memory tool `view`, `list`, `read` operation handlers implemented.

### Pair C — Update + Delete (Tasks 8, 9)

From `task-005-memory-updel-test.md` Gherkin (5 scenarios):

- [ ] **update replaces body**: body file content changes; rendered index reflects frontmatter changes; atomic tmp-rename.
- [ ] **update merges partial frontmatter**: body preserved; only the patched frontmatter field changes; other fields preserved.
- [ ] **update of unknown slug fails**: `isError: true` with `NOT_FOUND`; no new file created.
- [ ] **delete removes body file**: file no longer exists; next rendered index omits the slug.
- [ ] **deleting last fact in scope**: scope directory still exists; next rendered index omits the Project section; whole Memory section omitted if User scope is also empty.
- [ ] All 5 cases RED then GREEN.
- [ ] `FileMemoryStore.update` (partial frontmatter merge + atomic body replace) and `.delete` (plain rm, idempotent) implemented.
- [ ] Memory tool `update` and `delete` handlers implemented.

## Quality Requirements

- TypeScript style: `?: T` not `?: T | undefined`; pass `undefined` directly; single-param internal methods stay single-param; `#/...` imports.
- Reuse `canonicalizePath` + `isWithinDirectory` from `packages/agent-core/src/tools/policies/path-access.ts` for any path resolution in the store. Defense-in-depth only — slug regex catches most cases.
- Mirror `TodoListTool` (`packages/agent-core/src/tools/builtin/state/todo-list.ts:89-133`) for the tool class structure: `BuiltinTool<MemoryInput>`, `resolveExecution(args)` returning a `ToolExecution`.
- Mirror `EditTool` (`packages/agent-core/src/tools/builtin/file/edit.ts`) for atomic file mutation patterns.
- Sibling `memory.md` description file: minimal placeholder is fine in this batch (full text lands in Task 20). The `MemoryTool` `description` field must load it via the `.md` loader pattern (see `todo-list.md` + `todo-list.ts:22`).
- No `body` content in tool-result warnings (secret detection): name only the matched pattern category (e.g. `"anthropic-key"`, `"github-token"`, etc.).
- Secret-pattern list from `best-practices.md` §Security: `sk-[A-Za-z0-9-]{20,}`, `gh[pousr]_[A-Za-z0-9]{36}`, `AKIA[0-9A-Z]{16}`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`, `xox[baprs]-[A-Za-z0-9-]{10,}`. Match-and-warn, do NOT block.
- No co-author / no agent identity in any text artifact.
- No emojis, no AI slop, no defensive try/catch in trusted paths.

## Verification Commands

The coordinator must run after each pair AND globally after all six tasks:

```bash
cd /Users/FradSer/Developer/FradSer/kimi-code
pnpm typecheck
pnpm test packages/agent-core/test/tools/memory.test.ts
pnpm test packages/agent-core/test/profile/context.test.ts     # no regression
pnpm test packages/agent-core/test/skill                       # no regression
pnpm lint packages/agent-core/src/memory packages/agent-core/src/tools/builtin/state/memory.ts packages/agent-core/src/tools/builtin/index.ts packages/agent-core/src/agent/tool/index.ts
```

All must exit 0.

## Out of scope (do NOT do in this batch)

- Wiring `loadMemory` into `prepareSystemPromptContext` (Task 11 / Batch 3 owns it).
- Telemetry events (Task 19 / Batch 4 owns it; for now, no `track()` calls in the tool).
- Plan-mode policy extension (Task 15 / Batch 3).
- TUI / `/memory` / `/remember` (Task 17 / Batch 4).
- Final `memory.md` agent-facing tool description text (Task 20 / Batch 5). Minimal placeholder is fine.

## Sign-off

Revision: 1
Written by: executing-plans main agent
Date: 2026-05-27
