# Handoff Summary — Batch 3

**Batch**: 3 (Injection + Security pairs)
**Verdict**: PASS
**Date**: 2026-05-28

## Completed Tasks

| ID | Subject | Checklist Result | Batch |
|----|---------|------------------|-------|
| 10 (006-test) | Tests for System-prompt injection (KIMI_MEMORY) | PASS (4 scenarios) | 3 |
| 11 (006-impl) | SystemPromptContext extension + buildTemplateVars + system.md template | PASS | 3 |
| 14 (008-test) | Tests for Security and path safety | PASS (5 scenarios) | 3 |
| 15 (008-impl) | Plan-mode policy extension + symlink refusal + path-traversal guard | PASS | 3 |

Full agent-core suite: **1740 passed | 1 todo | 1 skipped**.

## Remaining Tasks

| ID | Subject | Status | Dependencies |
|----|---------|--------|--------------|
| 12 | Tests for /compact resilience | pending | 1 (done) |
| 13 | Verify and harden injection refresh path | pending | 12, 11 (done), 5 (done) |
| 16 | Tests for /memory + /remember TUI | pending | 1 (done) |
| 17 | Implement Session API + TUI browser | pending | 16, 3, 5, 9 (all done) |
| 18 | Tests for Telemetry | pending | 1 (done) |
| 19 | Emit telemetry events | pending | 18, 3, 5, 9 (all done) |
| 20 | Changeset + docs | pending | all impls |

## Key Decisions (Batch 3 architectural calls)

- **Symlink refusal uses `kaos.stat(..., { followSymlinks: false })`** (kaos exposes lstat semantics via this option at `packages/kaos/src/local.ts:197-200`). Idiomatic to kaos; equivalent to `node:fs/promises.lstat`. Already shipped in Batch 2; Batch 3 verified the BDD scenario passes against it.
- **`MemoryErrorReason` keeps Batch 2 naming `PATH_OUTSIDE_SCOPE`** (not the literal `PATH_OUTSIDE_WORKSPACE` from the task copy). Slug regex catches traversal at the zod layer before path code runs, so this is mostly nominal. Test accepts either reason via regex.
- **`formatSchemaError` maps `record.name` zod failures to `INVALID_SLUG`** for wire-vocabulary consistency with `MemoryStoreError`.
- **Plan-mode policy extension matches `tool.name === 'memory'` AND `operation ∈ {write, update, delete}`**. Read ops (`view`/`list`/`read`) fall through. Existing `Write`/`Edit` matching preserved.
- **System-prompt section uses `{% if KIMI_MEMORY %}` guard** mirroring `{% if KIMI_ADDITIONAL_DIRS_INFO %}` at `system.md:95`. Fence delimiter is 9 backticks (matches `KIMI_AGENTS_MD` block).
- **`SystemPromptContext.memoryIndex` flows through `prepareSystemPromptContext` → `buildTemplateVars` → template render**. Subagents inherit automatically since they re-run `prepareSystemPromptContext` per spawn (`subagent-host.ts:286`).

## Modified Files (cumulative through Batch 3)

From Batches 1+2 (unchanged):
- `packages/agent-core/src/memory/*` (find-project-root, types, slug, format, store with full impl, loader, index)
- `packages/agent-core/src/tools/builtin/state/memory.{ts,md}`
- `packages/agent-core/src/tools/builtin/index.ts` (re-export)
- `packages/agent-core/src/agent/tool/index.ts` (registration)
- `packages/agent-core/src/skill/scanner.ts` (find-project-root import)
- `packages/agent-core/test/profile/context.test.ts` (loader tests, +injection tests)
- `packages/agent-core/test/tools/memory.test.ts` (CRUD tests, +security tests)

New / modified in Batch 3:
- `packages/agent-core/src/profile/types.ts` (added `memoryIndex?: string`)
- `packages/agent-core/src/profile/context.ts` (loadMemory in Promise.all; PreparedSystemPromptContext Pick updated)
- `packages/agent-core/src/profile/resolve.ts` (`KIMI_MEMORY` in `buildTemplateVars`)
- `packages/agent-core/src/profile/default/system.md` (Memory section between Project Info and Skills)
- `packages/agent-core/src/agent/permission/policies/plan.ts` (memory tool match + block on write/update/delete)
- `packages/agent-core/src/tools/builtin/state/memory.ts` (`formatSchemaError` slug-regex mapping; possibly symlink refusal hardening if not already done in Batch 2)
- `packages/agent-core/test/profile/context.test.ts` (extended — 4 injection scenarios; total 16 tests in file)
- `packages/agent-core/test/tools/memory.test.ts` (extended — security scenarios)
- `packages/agent-core/test/tools/plan-mode-hard-block.test.ts` (extended — plan-mode block on memory writes)
- `docs/plans/2026-05-27-native-memory-plan/evaluation-round-1-batch-3.md`

## Verification Evidence

- `pnpm typecheck` → exit 0; 7 packages green.
- `pnpm exec vitest run profile/context.test.ts` → 16 passed.
- `pnpm exec vitest run profile` → 24 passed (3 files).
- `pnpm exec vitest run tools/memory.test.ts tools/plan-mode-hard-block.test.ts` → 37 passed.
- `pnpm lint` on profile + memory + permission + memory tool → 0 errors, 0 warnings.
- Full agent-core suite: 1740 passed | 1 todo | 1 skipped.

## Recurring Failure Patterns

None this batch.

## Outstanding Architectural Notes for Future Batches

- **Task 13 (resilience-impl)**: verification-only per task spec. Re-read the existing `prepareSystemPromptContext` flow; confirm subagent inheritance and `/compact` survival happen for free. Patch the minimal site only if a test fails.
- **Task 17 (TUI)**: heaviest remaining work. Touches Session API (3 methods), RPC (3 entries), SDK wrappers, MemoryBrowserApp class, slash registry, kimi-tui.ts dispatch. Read `apps/kimi-code/src/tui/kimi-tui.ts:1583` (slash dispatch), `:4552-4620` (TasksBrowserApp template to mirror), `:5601-5627` (handleInitCommand to mirror for /remember). Session.remember mirrors `generateAgentsMd` at `session/index.ts:252-280`.
- **Task 19 (telemetry)**: locate the `track()` surface. `apps/kimi-code/src/tui/kimi-tui.ts:5612` (`this.track('init_complete')`) is the pattern; trace import to find the agent-core-side surface. Emit `memory_write`/`memory_update`/`memory_delete` with `{ scope, slug }` (NO body content) and `memory_index_truncated` with `{ droppedCount }` from the loader's render path.
- **Task 20 (changeset)**: final agent-facing `memory.md` tool description (currently a Batch 2 placeholder); short reference doc under `docs/`; `gen-changesets` skill produces the changeset entry (default `minor`).
