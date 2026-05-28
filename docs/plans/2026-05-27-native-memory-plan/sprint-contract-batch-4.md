# Batch 4 Sprint Contract

**Plan**: `docs/plans/2026-05-27-native-memory-plan/`
**Batch scope**: Two Red-Green pairs — both lightweight, both build atop the existing memory module:
  - Pair A: Resilience verification (Tasks 12 + 13) — `/compact` survival + subagent visibility + session-restart re-read
  - Pair B: Telemetry (Tasks 18 + 19) — emit events for memory mutations + index truncation
**Execution mode**: Linear-of-pairs (A → B). Pair A is verification-only per the task spec; expected to be a thin patch or no source change. Pair B adds a few `track()` calls in `MemoryTool` and the loader's renderer.
**Revision**: 1

## Tasks

| ID (TaskList) | Plan ID | Subject | Type |
|---|---|---|---|
| 12 | 007-test | Tests for Survives /compact and session restart | test |
| 13 | 007-impl | Verify and harden injection refresh path | impl (verification-only) |
| 18 | 010-test | Tests for Telemetry events | test |
| 19 | 010-impl | Emit telemetry events from Memory tool ops + truncation | impl |

## Acceptance Criteria

### Pair A — Resilience (Tasks 12, 13)

From `task-007-resilience-test.md` (3 scenarios):

- [ ] **Resuming a session re-reads memory from disk**: a previous session wrote fact "x" to project scope; the session metadata is persisted but the in-memory cache is empty; on resume, the first rendered system prompt contains fact "x"; the index is read from disk (not from session state).
- [ ] **/compact preserves memory injection**: memory contains fact "y"; user runs /compact; the next turn's assembled system prompt still contains fact "y"; no duplicate `# Memory` section is rendered.
- [ ] **Subagent write visible to parent on next turn**: a spawned subagent calls `operation: write` for slug "newfact"; the parent's CURRENT system prompt does NOT contain "newfact" (already-committed); the parent's NEXT turn's system prompt DOES contain "newfact".
- [ ] All 3 cases RED first, GREEN after impl.
- [ ] Tests extend `packages/agent-core/test/profile/context.test.ts` (re-read on resume; cheap to test there because the rendered system-prompt path is identical to existing AGENTS.md tests). `/compact` and subagent-visibility tests extend the nearest existing compaction / subagent test file under `packages/agent-core/test/` — locate at execution time; if none fits, add a new `test/memory/resilience.test.ts`.
- [ ] **No source changes expected** — the design predicts the existing flow handles all three for free. If a test fails, patch the minimal site (probably one of: `agent/compaction/full.ts`, `session/subagent-host.ts`, `profile/context.ts`); do NOT introduce a new "memory refresh" hook.

### Pair B — Telemetry (Tasks 18, 19)

From `task-010-telemetry-test.md` (2 scenarios):

- [ ] **Each mutation emits a telemetry event**: successful `operation: write | update | delete` emits the corresponding `memory_write` / `memory_update` / `memory_delete` event; payload `{ scope, slug }`; **NO body content** in payload.
- [ ] **Index truncation increments a counter**: when `renderIndex` truncates entries due to the 8 KB budget, a `memory_index_truncated` event fires with `{ droppedCount: N }`.
- [ ] All 2 cases RED first, GREEN after impl.
- [ ] Telemetry-tool tests extend `packages/agent-core/test/tools/memory.test.ts`.
- [ ] Truncation-counter test extends `packages/agent-core/test/profile/context.test.ts` (the renderer fires during system-prompt assembly).
- [ ] `MemoryTool.resolveExecution` emits the mutation events on each successful op (after the store call returns, before the result is serialized).
- [ ] `renderIndex` (in `loader.ts`) emits `memory_index_truncated` when its `droppedSlugs` is non-empty.
- [ ] Event-emission must NOT fail the tool operation if the telemetry sink itself errors — fire-and-forget.

## Quality Requirements

- TypeScript style per repo `AGENTS.md`.
- **Locate the telemetry surface**: trace `this.track('init_complete')` at `apps/kimi-code/src/tui/kimi-tui.ts:5612` to find the import. Inspect `packages/telemetry/` and `packages/agent-core/src/telemetry.ts` (or equivalent) to find the right `track(event, payload)` function callable from agent-core.
- **No body content** in any telemetry payload — assert this in tests by spying on `track` and verifying the payload object's keys.
- Fire-and-forget: wrap telemetry calls so a thrown error in the sink does not propagate to the tool result.
- For Pair A's "no source change" path: if all 3 resilience tests pass without any source edits, do not invent changes. The verification-only nature is the intended outcome.
- No co-author / no agent identity / no emojis / no AI slop.

## Verification Commands

After all 4 tasks:

```bash
cd /Users/FradSer/Developer/FradSer/kimi-code
pnpm typecheck
pnpm exec vitest run packages/agent-core/test/tools/memory.test.ts
pnpm exec vitest run packages/agent-core/test/profile/context.test.ts
pnpm exec vitest run packages/agent-core/test/profile
pnpm exec vitest run packages/agent-core/test/agent  # compaction + subagent if exists
pnpm exec vitest run packages/agent-core/test/skill
pnpm lint packages/agent-core/src/memory packages/agent-core/src/profile packages/agent-core/src/tools/builtin/state/memory.ts
```

All exit 0. Capture last 20 lines.

## Out of scope

- TUI / `/memory` / `/remember` — Batch 5 (Tasks 16+17).
- Final `memory.md` tool description text — Batch 6 (Task 20).

## Sign-off

Revision: 1
Written by: executing-plans main agent
Date: 2026-05-28
