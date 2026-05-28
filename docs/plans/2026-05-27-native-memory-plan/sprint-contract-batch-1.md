# Batch 1 Sprint Contract

**Plan**: `docs/plans/2026-05-27-native-memory-plan/`
**Batch scope**: Foundation (Task 1) + Loader Red-Green pair (Tasks 2, 3)
**Execution mode**: Linear (1 → 2 → 3 sequentially; 2 and 3 form a Red-Green pair)
**Revision**: 1

## Tasks

| ID | Subject | Type |
|----|---------|------|
| 1 (plan id 001) | Setup foundation: find-project-root helper + memory module skeleton | setup |
| 2 (plan id 002-test) | Tests for Storage with layered scopes (loader + index render) | test |
| 3 (plan id 002-impl) | Implement loadMemory + renderIndex | impl |

## Acceptance Criteria (auto-derived from task BDD Then-clauses)

### Task 1: Setup foundation

Foundation task — no BDD scenarios. Acceptance criteria from task file's Verification section:
- [ ] `packages/agent-core/src/memory/find-project-root.ts` exists and exports `findProjectRoot(kaos, workDir): Promise<string>`.
- [ ] `packages/agent-core/src/memory/{types,slug,format,store,loader,index}.ts` exist with type definitions and function signatures only (no implementation bodies; method bodies throw `new Error('not implemented')`).
- [ ] `packages/agent-core/src/profile/context.ts:77-87` and `packages/agent-core/src/skill/scanner.ts:338-347` are updated to import `findProjectRoot` from the new shared module (inline duplicates removed).
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test packages/agent-core/test/profile/context.test.ts` still passes (existing AGENTS.md tests unaffected).
- [ ] `pnpm test packages/agent-core/test/skill` still passes.
- [ ] `grep -rn "findProjectRoot" packages/agent-core/src/` shows the helper imported from `#/memory/find-project-root` (and no other inline `findProjectRoot` definitions remain in `profile/context.ts` or `skill/scanner.ts`).

### Task 2: Tests for Storage with layered scopes (8 scenarios)

For each `Then` clause in the 8 BDD scenarios under "Feature: Storage with layered scopes":

- [ ] **Loading from user scope only**: the rendered index lists "code-style" under the User section; the index is annotated with the user-scope source path; no Project section is rendered.
- [ ] **Loading from project scope only**: the rendered index lists "build-commands" under the Project section; the index is annotated with the project-scope source path.
- [ ] **Loading merged user and project indexes**: both facts appear in the rendered index; the Project section appears before the User section.
- [ ] **Project slug shadows user slug**: exactly one entry for slug "code-style" is rendered; that entry comes from the Project section; the user-scope fact remains addressable.
- [ ] **Subagent inherits parent's memory index**: the subagent's system prompt contains the "test-runner" index entry; the subagent's index is loaded fresh from disk.
- [ ] **Missing memory directory handled silently**: no Memory section is injected; no error or warning is recorded; no empty header is rendered.
- [ ] **Non-git working directory**: only the user-scope index is loaded; no project-scope lookup is attempted.
- [ ] **Reserved filename MEMORY.md is skipped**: the file named "MEMORY.md" is not treated as a fact; no entry for slug "memory" is rendered from that file.
- [ ] All 8 test cases initially FAIL (RED state) because `loader.ts` throws `not implemented`.
- [ ] Tests added to `packages/agent-core/test/profile/context.test.ts` (extend existing file, per repo `AGENTS.md`).

### Task 3: Implement loadMemory + renderIndex

After Task 2's tests are written:

- [ ] `loadMemory(kaos, workDir)` reads user-scope from `~/.kimi-code/memory/`, project-scope from `<git-root>/.kimi-code/memory/`, merges with project-override-user.
- [ ] `renderIndex` produces output with `## Project (<path>)` and `## User (<path>)` section headers in that order; per-entry line is `- [<slug>](<slug>.md) (<type>) — <description>`.
- [ ] Empty merged set returns `""`.
- [ ] `MEMORY.md` filename is skipped in scope-dir scans.
- [ ] All 8 test cases from Task 2 now PASS (GREEN).
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint` passes.
- [ ] Existing AGENTS.md / skill tests still pass (no regression).

## Quality Requirements

- TypeScript style: no `?: T | undefined` (use `?: T`); pass `undefined` directly, no conditional spread; single-param internal methods stay single-param.
- Imports: use `#/...` subpath imports, not `../../../`.
- Frontmatter parsing in `format.ts`: reuse `parseFrontmatter` from `packages/agent-core/src/skill/parser.ts`. Do not duplicate YAML parsing.
- No new test files beyond what task files prescribe. Extend `packages/agent-core/test/profile/context.test.ts` for loader tests (do not create a new file).
- No co-author attribution / no agent identity (per repo `AGENTS.md:11-12`).

## Verification Commands

The batch coordinator must run all of these after the batch's GREEN step and report each output's last 20 lines as evidence:

- `cd /Users/FradSer/Developer/FradSer/kimi-code && pnpm typecheck`
- `cd /Users/FradSer/Developer/FradSer/kimi-code && pnpm test packages/agent-core/test/profile/context.test.ts`
- `cd /Users/FradSer/Developer/FradSer/kimi-code && pnpm test packages/agent-core/test/skill`
- `cd /Users/FradSer/Developer/FradSer/kimi-code && pnpm lint packages/agent-core/src/memory packages/agent-core/src/profile/context.ts packages/agent-core/src/skill/scanner.ts`

All must exit 0.

## Sign-off

Revision: 1
Written by: executing-plans main agent
Date: 2026-05-27
