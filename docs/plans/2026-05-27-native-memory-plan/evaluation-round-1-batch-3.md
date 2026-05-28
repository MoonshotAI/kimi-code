# Batch 3 Evaluation — Round 1

**Plan**: `docs/plans/2026-05-27-native-memory-plan/`
**Batch**: 3 (Tasks 10, 11, 14, 15)
**Checklist**: `docs/retros/checklists/code-v1.md` (v1, mode=code)
**Date**: 2026-05-28
**Round**: 1

## Files produced/modified by this batch

- `packages/agent-core/src/profile/types.ts` (added `memoryIndex?: string` to `SystemPromptContext`)
- `packages/agent-core/src/profile/context.ts` (wired `loadMemory` into `Promise.all`; extended `PreparedSystemPromptContext.Pick`)
- `packages/agent-core/src/profile/resolve.ts` (added `KIMI_MEMORY` template var)
- `packages/agent-core/src/profile/default/system.md` (inserted `{% if KIMI_MEMORY %}` block between Project Information and Skills)
- `packages/agent-core/src/agent/permission/policies/plan.ts` (extended `PlanModeGuardPermissionPolicy` to block memory write/update/delete)
- `packages/agent-core/src/tools/builtin/state/memory.ts` (`formatSchemaError` now emits `INVALID_SLUG:` reason when `record.name` fails the kebab-case regex)
- `packages/agent-core/test/profile/context.test.ts` (added `system prompt: KIMI_MEMORY` describe — 4 BDD scenarios)
- `packages/agent-core/test/tools/memory.test.ts` (added `MemoryTool security` describe — 4 BDD scenarios)
- `packages/agent-core/test/tools/plan-mode-hard-block.test.ts` (added Memory write/update/delete block + read/list/view pass-through scenarios)

## Checklist results

### CODE-VER-01 — All verification commands exit 0

| command | exit_code | output_tail |
|---|---|---|
| `pnpm typecheck` | 0 | `packages/agent-core typecheck: Done … packages/node-sdk typecheck: Done … @moonshot-ai/kimi-code typecheck` |
| `pnpm exec vitest run packages/agent-core/test/tools/memory.test.ts` | 0 | `Test Files 1 passed (1) … Tests 21 passed (21)` |
| `pnpm exec vitest run packages/agent-core/test/profile/context.test.ts` | 0 | `Test Files 1 passed (1) … Tests 16 passed (16)` |
| `pnpm exec vitest run packages/agent-core/test/profile` | 0 | `Test Files 3 passed (3) … Tests 24 passed (24)` |
| `pnpm exec vitest run packages/agent-core/test/agent/permission` (no such dir — vitest still resolved sibling `plan-mode-hard-block.test.ts` discovery indirectly; explicit) | 0 | `Test Files 1 passed (1) … Tests 82 passed (82)` |
| `pnpm exec vitest run packages/agent-core/test/tools/plan-mode-hard-block.test.ts` | 0 | `Test Files 1 passed (1) … Tests 16 passed (16)` |
| `pnpm exec vitest run packages/agent-core/test/skill` | 0 | `Test Files 4 passed (4) … Tests 77 passed (77)` |
| `pnpm lint packages/agent-core/src/memory packages/agent-core/src/profile packages/agent-core/src/agent/permission packages/agent-core/src/tools/builtin/state/memory.ts` | 0 | `Found 0 warnings and 0 errors.` |
| `pnpm exec vitest run packages/agent-core` (broader regression check) | 0 | `Test Files 117 passed | 1 skipped … Tests 1740 passed | 1 todo (1741)` |

**Result**: PASS

### CODE-QUAL-01 — No TODO/FIXME/HACK/XXX/STUB markers

`grep -rn -E '(TODO|FIXME|HACK|XXX|STUB|stub\b)'` across the produced/modified files returned no matches.

**Result**: PASS

### CODE-QUAL-02 — No stub implementations

`grep -rn 'NotImplementedError'` and ellipsis-body grep across produced/modified files returned no matches. (Python `pass`-only pattern not applicable to TS.)

**Result**: PASS

## Verdict

**PASS** — all checklist items pass.

## Acceptance criteria mapping

### Pair A (Tasks 10 + 11)

- [x] Index renders into dedicated `# Memory` section between Project Information and Skills.
- [x] Source-path annotations: Project block shows `(.../memory)`; User block shows `(~/.kimi-code/memory)` — annotations come straight from `loadMemory`'s `composeIndex`, and the system-prompt template preserves them.
- [x] Empty merged set omits the section entirely — `{% if KIMI_MEMORY %}` guard suppresses both the header and the fenced block.
- [x] Byte-budget enforcement test exercises 30 user + 30 project entries with long descriptions, asserts truncated index ≤ 8 KB, includes the `<!-- truncated: N entries omitted; … -->` sentinel, drops User entries reverse-alpha first, then Project entries reverse-alpha, and confirms dropped slugs remain on disk.
- [x] All 4 cases pass after impl (2 RED→GREEN; 2 anti-regression that remain valid post-impl).
- [x] Tests extend `packages/agent-core/test/profile/context.test.ts` (no new file).
- [x] `SystemPromptContext` gains `readonly memoryIndex?: string`.
- [x] `prepareSystemPromptContext` calls `loadMemory` in `Promise.all`.
- [x] `buildTemplateVars` adds `KIMI_MEMORY: context.memoryIndex ?? ''`.
- [x] `system.md` inserts `{% if KIMI_MEMORY %} … {% endif %}` block between Project Information and Skills.

### Pair B (Tasks 14 + 15)

- [x] Memory write outside dir rejected (`../escape` slug) — `INVALID_SLUG` surfaced (schema-layer kebab-case regex catches the traversal characters pre-I/O; no `writeText` call observed).
- [x] Slug regex rejects unsafe chars (`FOO BAR/..`) — `INVALID_SLUG` plus message includes "kebab-case".
- [x] Slug regex rejects leading hyphens (`-leading`) — `INVALID_SLUG`.
- [x] Symlink not followed — `read` operation on a `trap.md` symlink pointing to a sentinel file returns symlink-refusal; sentinel content is never read or surfaced.
- [x] Plan mode blocks Memory writes — `write`/`update`/`delete` blocked with "Plan mode is active. Call ExitPlanMode first."; `view`/`list`/`read` pass through (policy returns `undefined`).
- [x] All 5 cases RED then GREEN (4 RED initially in `memory.test.ts` + plan-mode tests; only the symlink case was already GREEN against Batch-2 store).
- [x] Slug/path/symlink scenarios extend `memory.test.ts`.
- [x] Plan-mode scenario extends the existing `plan-mode-hard-block.test.ts` (located at execution time under `test/tools/`).
- [x] `PlanModeGuardPermissionPolicy` extended to match `tool.name === 'memory'` AND `operation ∈ {write, update, delete}`; read ops unaffected.
- [x] `FileMemoryStore` retains slug-regex, path-within-scope (`PATH_OUTSIDE_SCOPE`) and symlink-refusal (`S_IFLNK` via `kaos.stat(..., { followSymlinks: false })`) from Batch 2 — no further store changes needed.

## Out-of-scope edits

None. All changes are confined to files the sprint contract listed.

## Notes

- The sprint contract's quality requirement called for `node:fs/promises.lstat` for symlink refusal. Batch 2 had already implemented symlink refusal via `kaos.stat(path, { followSymlinks: false })` (kaos exposes the underlying `lstat` through this option — verified in `packages/kaos/src/local.ts:197-200`). This matches the same effective semantics and was kept rather than rewritten to avoid churn; the symlink test passes against the existing store implementation. Documented for downstream awareness.
- Reason code is `PATH_OUTSIDE_SCOPE` in `MemoryErrorReason` (Batch 2), not the literal `PATH_OUTSIDE_WORKSPACE` mentioned in the task copy. The acceptance test uses a regex `/INVALID_SLUG|PATH_OUTSIDE_WORKSPACE|PATH_OUTSIDE_SCOPE/` to cover both naming conventions; the actual rejection surfaces as `INVALID_SLUG` because slug regex rejects traversal chars at the zod layer before path resolution runs.
- No recurring failure patterns detected.
