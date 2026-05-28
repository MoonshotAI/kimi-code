# Batch 3 Sprint Contract

**Plan**: `docs/plans/2026-05-27-native-memory-plan/`
**Batch scope**: Two Red-Green pairs that wire the memory subsystem into the system prompt and harden its boundaries:
  - Pair A: System-prompt injection (Tasks 10 + 11)
  - Pair B: Security & path safety (Tasks 14 + 15)
**Execution mode**: Linear-of-pairs (A → B). Pair B's impl depends on `FileMemoryStore.write` (already shipped in Batch 2) and on the plan-mode policy wiring — these are independent of Pair A in source-file terms (A touches `profile/`, B touches `memory/store.ts` + `agent/permission/policies/plan.ts`).
**Revision**: 1

## Tasks

| ID (TaskList) | Plan ID | Subject | Type |
|---|---|---|---|
| 10 | 006-test | Tests for System-prompt injection (KIMI_MEMORY) | test |
| 11 | 006-impl | Implement SystemPromptContext extension + buildTemplateVars + system.md template | impl |
| 14 | 008-test | Tests for Security and path safety | test |
| 15 | 008-impl | Implement path-traversal guard + symlink refusal + plan-mode policy | impl |

## Acceptance Criteria

### Pair A — Injection (Tasks 10, 11)

From `task-006-injection-test.md` (4 scenarios):

- [ ] **Index renders into dedicated section**: rendered system prompt contains a `# Memory` section between `# Project Information` and `# Skills`.
- [ ] **Source-path annotations**: rendered Project block heading mentions the project memory directory path; User block heading mentions `~/.kimi-code/memory`.
- [ ] **Empty merged set omits section entirely**: no `# Memory` header; no annotation comments.
- [ ] **Byte-budget enforcement**: when merged index > 8 KB rendered, User entries drop first (reverse-alpha), then Project entries (reverse-alpha); sentinel `<!-- truncated: N entries omitted; call Memory.list for the full set -->` appended; `list` operation still returns the full untruncated set.
- [ ] All 4 cases RED first, GREEN after impl.
- [ ] Tests extend `packages/agent-core/test/profile/context.test.ts` (no new file).
- [ ] `SystemPromptContext` (in `packages/agent-core/src/profile/types.ts`) gains `readonly memoryIndex?: string`.
- [ ] `prepareSystemPromptContext` in `profile/context.ts` calls `loadMemory` in `Promise.all` alongside `loadAgentsMd`/`listDirectory` and returns `memoryIndex`.
- [ ] `buildTemplateVars` in `profile/resolve.ts` adds `KIMI_MEMORY: context.memoryIndex ?? ''`.
- [ ] `profile/default/system.md` inserts a `{% if KIMI_MEMORY %} ... {% endif %}` block between Project Information and Skills sections.

### Pair B — Security (Tasks 14, 15)

From `task-008-security-test.md` (5 scenarios):

- [ ] **Memory write outside dir rejected**: slug containing `../escape` → `isError: true` with reason matching `PATH_OUTSIDE_WORKSPACE` or `INVALID_SLUG`; no file created; no I/O outside the memory dir.
- [ ] **Slug regex rejects unsafe chars**: slug `"FOO BAR/.."` → `isError: true` with `INVALID_SLUG`; message names the allowed slug pattern.
- [ ] **Slug regex rejects leading/trailing hyphens**: `"-leading"` → `INVALID_SLUG`; no file created.
- [ ] **Symlink not followed**: a symlink inside the project memory dir pointing to `/etc/passwd`; `operation: read` on its slug → `isError: true` with symlink-refusal reason; `/etc/passwd` not read.
- [ ] **Plan mode blocks Memory writes**: when plan mode is active, `operation: write | update | delete` → `isError: true` with a message instructing to call `ExitPlanMode`; `view | list | read` still succeed.
- [ ] All 5 cases RED then GREEN.
- [ ] Slug/path-traversal scenarios extend `packages/agent-core/test/tools/memory.test.ts`.
- [ ] Plan-mode block scenario extends the existing plan-mode policy test file (locate at execution time: `packages/agent-core/test/...` — likely under `test/agent/permission/` or `test/tools/plan-mode-hard-block.test.ts`); if no suitable file exists, extend `memory.test.ts`.
- [ ] `packages/agent-core/src/agent/permission/policies/plan.ts` extended to match `tool.name === 'memory'` AND `input.operation ∈ {write, update, delete}` → block with reason "Plan mode is active. Call ExitPlanMode first." Read ops unaffected.
- [ ] `FileMemoryStore` already enforces slug regex (via Batch 2's `MemoryStoreError(INVALID_SLUG)`); confirm symlink refusal and path-within-scope are wired (extend if Batch 2 didn't fully cover).

## Quality Requirements

- TypeScript style per repo `AGENTS.md`: `?: T`; pass `undefined` directly; single-param internal methods stay single-param; `#/...` imports.
- Plan-mode policy: mirror the existing `PlanModeGuardPermissionPolicy` (`packages/agent-core/src/agent/permission/policies/plan.ts:80-118`) pattern — same shape, same return type. Don't duplicate the policy class.
- Template var: add `KIMI_MEMORY` near `KIMI_AGENTS_MD` in `buildTemplateVars` (`profile/resolve.ts`). Use the same `?? ''` fallback pattern as existing vars.
- `system.md`: use the Jinja-style `{% if KIMI_MEMORY %}` guard identical to `{% if KIMI_ADDITIONAL_DIRS_INFO %}` at `system.md:95`.
- Memory section text content per design `architecture.md` §9: explanation paragraph + the `{{ KIMI_MEMORY }}` block fenced with backticks.
- Symlink refusal: use `stat` (or `lstat`) to detect; refuse without following. Kaos doesn't proxy these — use `node:fs/promises.lstat` consistent with Batch 2's `node:fs/promises.rename` precedent.
- No co-author / no agent identity / no emojis / no AI slop.

## Verification Commands

After all 4 tasks:

```bash
cd /Users/FradSer/Developer/FradSer/kimi-code
pnpm typecheck
pnpm exec vitest run packages/agent-core/test/tools/memory.test.ts
pnpm exec vitest run packages/agent-core/test/profile/context.test.ts
pnpm exec vitest run packages/agent-core/test/profile  # all profile tests, including resolve
pnpm exec vitest run packages/agent-core/test/agent/permission  # if it exists
pnpm exec vitest run packages/agent-core/test/skill
pnpm lint packages/agent-core/src/memory packages/agent-core/src/profile packages/agent-core/src/agent/permission packages/agent-core/src/tools/builtin/state/memory.ts
```

All exit 0. Capture last 20 lines.

## Out of scope

- TUI / `/memory` / `/remember` (Task 17 / Batch 4).
- Telemetry events (Task 19 / Batch 4).
- Resilience / `/compact` survival tests (Task 13 / Batch 4 — verification-only).
- Final `memory.md` tool description text (Task 20 / Batch 5).

## Sign-off

Revision: 1
Written by: executing-plans main agent
Date: 2026-05-28
