# Handoff Summary — Batch 5

**Batch**: 5 (TUI: /memory browser + /remember session API)
**Verdict**: PASS
**Date**: 2026-05-28

## Completed Tasks

| ID | Subject | Checklist Result | Batch |
|----|---------|------------------|-------|
| 16 (009-test) | Tests for /memory + /remember (Session API + TUI browser + registry) | PASS (25 tests across 3 files) | 5 |
| 17 (009-impl) | Session API + RPC + SDK + MemoryBrowserApp + slash registry + dispatch | PASS | 5 |

Cumulative test counts:
- agent-core suite: **1758 passed | 1 todo** (+5 from Batch 4)
- apps/kimi-code suite: **902 passed | 2 skipped (904)**
- session tests (5 files): **48 passed**
- memory tool tests: **27 passed**
- profile tests: **31 passed**

## Remaining Tasks

| ID | Subject | Status | Dependencies |
|----|---------|--------|--------------|
| 20 | Changeset + memory.md tool description + reference doc | pending | all impls (done) |

## Key Decisions (Batch 5 architectural calls)

- **Wire type vs domain type**: added `MemoryFactSummary` (wire/RPC payload type) on `core-api.ts` distinct from `MemoryEntry` (domain type). Domain types re-exported through `packages/agent-core/src/index.ts` and SDK `packages/node-sdk/src/types.ts` so TUI can `import { MemoryFactSummary, MemoryScope } from '@moonshot-ai/kimi-code-sdk'`.
- **`listMemory` includes full body in wire response** — eliminates a second per-fact RPC for the TUI preview pane. Bounded by 4 KB × ~few dozen facts.
- **`shadowed` flag computed server-side** in `SessionAPIImpl.listMemory` via project-slug Set on the user-scope iteration.
- **`Session.memoryStore()` constructs a fresh `FileMemoryStore` per call**. Tool caches its own via `storePromise`; two stores share files, no in-memory state. Consistent with the existing tool's design — no cross-instance cache needed.
- **`Session.remember` mirrors `generateAgentsMd`** exactly: `parentToolCallId: 'remember'`, origin `{ kind: 'system_trigger', name: 'remember' }`. Errors wrapped in existing `KimiError(SESSION_INIT_FAILED, ...)` — no new error code added (out of scope).
- **TUI browser tested at state-machine / pure-component level**: props in → rendered string + callback invocations out. No pi-tui rendering pipeline required. 12 test cases cover all 6 BDD scenarios + navigation / filter ergonomics.
- **`/remember` queueing not behaviorally tested**: implemented `handleRememberCommand` as a direct mirror of `handleInitCommand` (deferUserMessages → beginSessionRequest → session.remember → track → finalizeTurn → isAbortError reset). The two methods are visually identical save for the call. Behavioral testing the queue path would require harnessing the entire kimi-tui flow — repo has no precedent.
- **Pre-existing lint warnings on `kimi-tui.ts`** (2 switch-exhaustiveness) confirmed not introduced by this batch via baseline `git stash` + lint check.

## Modified Files (delta from Batch 4)

### agent-core
- `packages/agent-core/src/session/index.ts` (added `listMemory`, `deleteMemory`, `remember`, `memoryStore()`)
- `packages/agent-core/src/session/rpc.ts` (RPC handlers for the three new methods)
- `packages/agent-core/src/rpc/core-api.ts` (added `MemoryFactSummary` wire type + method signatures)
- `packages/agent-core/src/rpc/core-impl.ts` (implementations)
- `packages/agent-core/src/index.ts` (re-export domain memory types — `MemoryEntry`, `MemoryScope`, `MemoryRecord`, etc.)

### node-sdk
- `packages/node-sdk/src/rpc.ts` (client-side bindings)
- `packages/node-sdk/src/session.ts` (`listMemory`, `deleteMemory`, `remember` wrappers)
- `packages/node-sdk/src/types.ts` (re-exports memory types + `MemoryFactSummary`)

### TUI (apps/kimi-code)
- `apps/kimi-code/src/tui/memory/browser.ts` (new — `MemoryBrowserApp`)
- `apps/kimi-code/src/tui/memory/state.ts` (new — UI state machine)
- `apps/kimi-code/src/tui/commands/registry.ts` (added `memory` + `remember` entries)
- `apps/kimi-code/src/tui/kimi-tui.ts` (dispatch cases + `handleMemoryCommand` + `handleRememberCommand`)

### Tests
- `packages/agent-core/test/session/memory.test.ts` (new — Session API tests)
- `apps/kimi-code/test/tui/memory-browser.test.ts` (new — browser tests)
- `apps/kimi-code/test/tui/commands/registry.test.ts` (extended)

### Plan artifacts
- `docs/plans/2026-05-27-native-memory-plan/evaluation-round-1-batch-5.md` (new)

## Verification Evidence

```
pnpm typecheck                                       → exit 0 (7 packages green)
vitest agent-core/test/session                        → 48 passed (5 files)
vitest agent-core/test/tools/memory.test.ts           → 27 passed
vitest agent-core/test/profile                        → 31 passed
vitest agent-core/test/skill                          → 77 passed
vitest apps/kimi-code/test                            → 902 passed | 2 skipped (904)
pnpm lint                                             → 0 errors / 0 new warnings
Full agent-core suite                                 → 1758 passed | 1 todo
```

## Recurring Failure Patterns

None this batch.

## Outstanding Architectural Notes for Future Batches

- **Task 20 (Batch 6)**:
  - Finalize the agent-facing tool description at `packages/agent-core/src/tools/builtin/state/memory.md` (currently a Batch 2 placeholder). Sections per design `architecture.md` §4: when-to-use / when-NOT / scope guidance / operation reference / hygiene / project-memory-in-git note / subagent visibility timing / plan-mode block / reserved filename note.
  - Add `docs/reference/memory.md` — short human-facing reference (storage layout, how `/memory` and `/remember` work, .gitignore guidance, index byte budget, v1 limitations).
  - Run `gen-changesets` skill to produce a `minor` changeset entry covering `@moonshot-ai/agent-core`, `@moonshot-ai/kimi-code-sdk`, and `kimi-code`. Per repo `AGENTS.md:61`, NEVER write `major` — confirm with the user if there's any ambiguity (there shouldn't be; this is a new feature).
  - Final smoke verification: `pnpm typecheck && pnpm test && pnpm lint && pnpm build` from repo root.
