# Evaluation — Round 1, Batch 2

**Batch**: 2 (Memory tool: write / read / update / delete)
**Date**: 2026-05-28
**Checklist version**: `docs/retros/checklists/code-v1.md` (v1)
**Verdict**: **PASS**

## Files Under Evaluation

Created:
- `packages/agent-core/src/tools/builtin/state/memory.ts`
- `packages/agent-core/src/tools/builtin/state/memory.md`
- `packages/agent-core/test/tools/memory.test.ts`

Modified:
- `packages/agent-core/src/memory/store.ts` (filled all method bodies + added `MemoryStoreError`)
- `packages/agent-core/src/tools/builtin/index.ts` (re-export `./state/memory`)
- `packages/agent-core/src/agent/tool/index.ts` (register `new b.MemoryTool(kaos, workspace)` next to `TodoListTool`)

## CODE-VER-01 — All verification commands exit with code 0

**Result**: PASS

| Command | Exit | Evidence (tail) |
|---|---|---|
| `pnpm typecheck` | 0 | All 7 workspace packages typecheck green; `packages/agent-core typecheck: Done`. |
| `pnpm exec vitest run test/tools/memory.test.ts` (from `packages/agent-core`) | 0 | `Test Files 1 passed (1); Tests 17 passed (17)`. |
| `pnpm exec vitest run test/profile/context.test.ts` | 0 | `Test Files 1 passed (1); Tests 12 passed (12)` — no regression. |
| `pnpm exec vitest run test/skill` | 0 | `Test Files 4 passed (4); Tests 77 passed (77)` — no regression. |
| `pnpm lint <produced paths>` | 0 | `Found 0 warnings and 0 errors. Finished in 253ms on 10 files`. |
| `pnpm exec vitest run` (full agent-core suite) | 0 | `Test Files 117 passed | 1 skipped (118); Tests 1726 passed | 1 todo (1727)`. |

## CODE-QUAL-01 — No TODO/FIXME/HACK/XXX/STUB markers in produced files

**Check**: `grep -rn -E '(TODO|FIXME|HACK|XXX|STUB|stub\b)' <produced files>`
**Result**: PASS — grep exit 1 (no matches).

## CODE-QUAL-02 — No stub implementations

**Checks**:
- `grep -rn 'NotImplementedError' <produced files>` — no matches.
- `grep -rn 'not implemented' <memory store + tool>` — no matches (all method bodies filled).
- `grep -rn -E '^[[:space:]]+pass[[:space:]]*$' <produced files>` — Python idiom; N/A in TypeScript.
- `grep -rn -E '^[[:space:]]+\.\.\.[[:space:]]*$' <produced files>` — no matches.

**Result**: PASS.

## Acceptance Criteria Cross-Check (sprint-contract-batch-2.md)

### Pair A — Writes (Tasks 4, 5) — all PASS
- Agent creates a new fact at the project-scope path with matching frontmatter — covered.
- Atomic write via tmp-rename; no `.tmp-*` file remains — verified via writeText spy.
- Duplicate slug → `isError: true`, `EXISTS`, suggests `update`, existing file unmodified.
- Body > 4 KB → `BODY_TOO_LARGE`; no file created. (Schema-level rejection mapped to `BODY_TOO_LARGE` in the tool wrapper so the message remains store-aligned.)
- Missing frontmatter field rejected; message lists missing `type` plus all 4 enum values.
- Secret content → write succeeds; warning names category (`anthropic-key`); raw match absent from output.

### Pair B — Reads (Tasks 6, 7) — all PASS
- `view` returns merged index grouped by scope; lines show slug/type/description; no body leak; fits in 8 KB.
- `list type=reference` returns only matching slugs.
- `list scope=user` returns only user-scope.
- `list` of 200-fact fixture returns the full untruncated set even when `view` truncates.
- `read` returns frontmatter + body verbatim.
- `read` of unknown slug → `NOT_FOUND`, names slug + scope, suggests `list`.

### Pair C — Update + Delete (Tasks 8, 9) — all PASS
- `update` replaces body atomically; tmp-rename observed; no leftover.
- `update` with partial `record.description` preserves body and other frontmatter fields.
- `update` of unknown slug → `NOT_FOUND`; no new file created.
- `delete` removes the body file; next rendered index omits the slug.
- Deleting the last fact in a scope leaves the empty scope dir; whole index empty when user scope is also empty.

## Notes for downstream batches

- `FileMemoryStore.update` resolves the path via `read()`, which uses `kaos.stat(path, { followSymlinks: false })` and refuses symlinks with `SYMLINK_REFUSED`. Batch 3 (Task 15, security guards) can extend without re-architecting.
- `MemoryStoreError` (`packages/agent-core/src/memory/store.ts`) is the canonical error type. Reasons: `INVALID_SLUG`, `BODY_TOO_LARGE`, `EXISTS`, `NOT_FOUND`, `SYMLINK_REFUSED`, `PATH_OUTSIDE_SCOPE`. Wire telemetry (Batch 4 / Task 19) can pivot off these.
- The MemoryTool builds its `FileMemoryStore` lazily via a cached `Promise` (`storePromise ??= ...`) so `findProjectRoot` runs at most once per tool instance.
- `memory.md` is a minimal placeholder per the contract; Task 20 (Batch 5) finalizes the agent-facing description.

## Verdict

**PASS** — all three checklist items pass; all 17 BDD scenarios green; no regressions in the existing 1726-test suite.
