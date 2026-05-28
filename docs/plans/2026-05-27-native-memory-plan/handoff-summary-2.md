# Handoff Summary — Batch 2

**Batch**: 2 (Store CRUD Red-Green pairs: write, read, update+delete)
**Verdict**: PASS
**Date**: 2026-05-27

## Completed Tasks

| ID | Subject | Checklist Result | Batch |
|----|---------|------------------|-------|
| 4 (003-test) | Tests for Agent writes via the Memory tool | PASS (6 scenarios, RED then GREEN) | 2 |
| 5 (003-impl) | Memory tool write + FileMemoryStore.write | PASS | 2 |
| 6 (004-test) | Tests for Agent reads via the Memory tool | PASS (6 scenarios) | 2 |
| 7 (004-impl) | Memory tool view/list/read + store list/read | PASS | 2 |
| 8 (005-test) | Tests for Agent updates and deletes | PASS (5 scenarios) | 2 |
| 9 (005-impl) | Memory tool update/delete + store update/delete | PASS | 2 |

Memory tool test file totals **17 scenarios, all passing**. Full agent-core suite: 1726 passed | 1 todo (no regressions).

## Remaining Tasks

| ID | Subject | Status | Dependencies |
|----|---------|--------|--------------|
| 10 | Tests for System-prompt injection | pending | 1 (done) |
| 11 | Implement injection wiring | pending | 10, 3 (done) |
| 12 | Tests for /compact resilience | pending | 1 (done) |
| 13 | Verify and harden injection refresh path | pending | 12, 11, 5 (done) |
| 14 | Tests for Security and path safety | pending | 1 (done) |
| 15 | Implement security guards + plan-mode policy | pending | 14, 5 (done) |
| 16 | Tests for /memory + /remember TUI | pending | 1 (done) |
| 17 | Implement Session API + TUI browser | pending | 16, 3, 5, 9 (done) |
| 18 | Tests for Telemetry | pending | 1 (done) |
| 19 | Emit telemetry events | pending | 18, 3, 5, 9 (done) |
| 20 | Changeset + docs | pending | all impls |

## Key Decisions (Batch 2 architectural calls)

- **`MemoryStoreError` exported from `memory/store.ts`** with `MemoryErrorReason` discriminant union. Downstream tasks (Task 15 security guards, Task 19 telemetry) can key off `error.reason` (`EXISTS`, `NOT_FOUND`, `BODY_TOO_LARGE`, `INVALID_SLUG`, `PATH_OUTSIDE_WORKSPACE`, `SYMLINK_REFUSED`, etc.).
- **Atomic write uses `node:fs/promises.rename` directly** because Kaos doesn't proxy rename. Consistent with `packages/agent-core/src/utils/fs.ts atomicWrite` and `tools/support/rg-locator.ts`. The tmp-file write still goes through `kaos.writeText` so test spies can observe the tmp-rename sequence.
- **Deletes use `node:fs/promises.unlink` directly** (same reason — no kaos proxy).
- **Body-size enforcement at two layers**: zod schema `max(4096)` rejects oversized bodies before any I/O; the tool's `formatSchemaError` maps the zod failure to the `BODY_TOO_LARGE` vocabulary so wire-level errors match the store-error vocabulary.
- **`MemoryTool` caches its `FileMemoryStore`** via `storePromise ??= this.buildStore()` — `findProjectRoot` resolves at most once per tool instance.
- **`MemoryTool.name = 'memory'`** (lowercase, matches design architecture §4 spec). Other builtins use TitleCase; design explicitly chose lowercase here.
- **Secret-pattern scan** runs on `write` body and emits a warning naming the pattern category. No raw match leaks into the wire log.

## Modified Files (cumulative through Batch 2)

From Batch 1 (unchanged):
- `packages/agent-core/src/memory/{find-project-root,types,slug,format,store,loader,index}.ts`
- `packages/agent-core/src/profile/context.ts` (find-project-root import only)
- `packages/agent-core/src/skill/scanner.ts` (find-project-root import only)
- `packages/agent-core/test/profile/context.test.ts` (loader tests)

New in Batch 2:
- `packages/agent-core/src/tools/builtin/state/memory.ts` (NEW — `MemoryTool` class)
- `packages/agent-core/src/tools/builtin/state/memory.md` (NEW — placeholder; Task 20 finalizes)
- `packages/agent-core/src/memory/store.ts` (filled in all method bodies; added `MemoryStoreError`)
- `packages/agent-core/src/tools/builtin/index.ts` (re-export `./state/memory`)
- `packages/agent-core/src/agent/tool/index.ts` (register `MemoryTool` near `TodoListTool`)
- `packages/agent-core/test/tools/memory.test.ts` (NEW — 17 scenarios)
- `docs/plans/2026-05-27-native-memory-plan/evaluation-round-1-batch-2.md`

## Verification Evidence

- `pnpm typecheck` → exit 0; 7 packages green.
- `pnpm exec vitest run test/tools/memory.test.ts` → 17 passed (6 write + 6 read + 5 updel).
- `pnpm exec vitest run test/profile/context.test.ts` → 12 passed (no regression).
- `pnpm exec vitest run test/skill` → 77 passed (no regression).
- `pnpm lint` on produced files → 0 warnings, 0 errors.
- Full agent-core suite: 1726 passed | 1 todo.

## Recurring Failure Patterns

None this batch.

## Outstanding Architectural Notes for Future Batches

- **Task 11 (injection wiring)**: must add `loadMemory` to `prepareSystemPromptContext`'s `Promise.all` and surface `memoryIndex` on `SystemPromptContext`. The loader is ready and tested.
- **Task 15 (security)**: the slug regex is already enforced at the zod schema level for `name`. `MemoryStoreError` codes `INVALID_SLUG`, `PATH_OUTSIDE_WORKSPACE`, `SYMLINK_REFUSED` should already exist or be added. The plan-mode policy extension needs to match `tool.name === 'memory'` AND `input.operation ∈ {write, update, delete}`.
- **Task 19 (telemetry)**: hook telemetry calls into `MemoryTool.resolveExecution` on each successful mutation. `track()` discovery: see `apps/kimi-code/src/tui/kimi-tui.ts:5612` for the pattern.
- **Task 17 (TUI)**: `Session.listMemory()` must call `loadMemory` infra (or the store directly) — confirm in implementation. `Session.remember(text)` mirrors `generateAgentsMd` at `session/index.ts:252-280`.
