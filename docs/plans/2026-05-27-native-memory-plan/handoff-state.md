# Handoff State (live snapshot — rewritten each batch)

**Plan**: `docs/plans/2026-05-27-native-memory-plan/`
**Updated**: after Batch 5, before Batch 6
**Active batch**: 6 (final)

## Completed task IDs (TaskList)

- 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19

## Remaining task

- 20 — Changeset + memory.md tool description + reference doc.

## Modified files (cumulative)

### Source files
- `packages/agent-core/src/memory/{find-project-root,types,slug,format,store,loader,index}.ts` (full memory module)
- `packages/agent-core/src/tools/builtin/state/memory.ts` (full `MemoryTool` + telemetry hooks)
- `packages/agent-core/src/tools/builtin/state/memory.md` (placeholder; Task 20 finalizes)
- `packages/agent-core/src/tools/builtin/index.ts` (re-export)
- `packages/agent-core/src/agent/tool/index.ts` (register MemoryTool)
- `packages/agent-core/src/agent/permission/policies/plan.ts` (memory write block)
- `packages/agent-core/src/profile/{types,context,resolve}.ts` (KIMI_MEMORY wiring + telemetry pass-through)
- `packages/agent-core/src/profile/default/system.md` (Memory section)
- `packages/agent-core/src/session/{index,rpc}.ts` (listMemory/deleteMemory/remember + memoryStore())
- `packages/agent-core/src/session/subagent-host.ts` (telemetry forwarding to child)
- `packages/agent-core/src/rpc/{core-api,core-impl}.ts` (RPC plumbing)
- `packages/agent-core/src/index.ts` (re-export domain memory types)
- `packages/agent-core/src/skill/scanner.ts` (shared findProjectRoot)
- `packages/node-sdk/src/{rpc,session,types}.ts` (SDK wrappers + type re-exports)
- `apps/kimi-code/src/tui/memory/{browser,state}.ts` (new — full-screen browser)
- `apps/kimi-code/src/tui/commands/registry.ts` (memory + remember entries)
- `apps/kimi-code/src/tui/kimi-tui.ts` (dispatch + handleMemoryCommand + handleRememberCommand)

### Test files
- `packages/agent-core/test/profile/context.test.ts` (23 tests — loader + injection + resilience + truncation telemetry)
- `packages/agent-core/test/tools/memory.test.ts` (27 tests — CRUD + security + mutation telemetry)
- `packages/agent-core/test/tools/plan-mode-hard-block.test.ts` (memory tool block)
- `packages/agent-core/test/session/memory.test.ts` (new — Session API)
- `apps/kimi-code/test/tui/memory-browser.test.ts` (new — browser state machine)
- `apps/kimi-code/test/tui/commands/registry.test.ts` (extended)

## Recurring Failure Patterns

None detected through Batch 5.

## Key Architectural Decisions (cumulative carried forward)

From design + plan + Batch 1-5 refinements:

- File-backed Markdown memory; two scopes (`user`, `project`); `MEMORY.md` render-only/reserved.
- Index 8 KB; body 4 KB.
- Project overrides User on slug collision (rendered index); user-scope facts remain addressable.
- Memory tool: builtin `memory` (lowercase) with `operation` discriminator (`view/list/read/write/update/delete`).
- Atomic writes via `kaos.writeText` + `node:fs/promises.rename`; deletes via `node:fs/promises.unlink`.
- Symlink refusal: `kaos.stat({ followSymlinks: false })`.
- Slug regex `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`; zod-layer enforcement; `formatSchemaError` maps to `INVALID_SLUG`.
- Frontmatter parser reused from `skill/parser.ts`.
- `MemoryStoreError` with `MemoryErrorReason` union (`EXISTS`, `NOT_FOUND`, `BODY_TOO_LARGE`, `INVALID_SLUG`, `PATH_OUTSIDE_SCOPE`, `SYMLINK_REFUSED`).
- `MemoryTool` caches `FileMemoryStore` via lazy promise.
- Secret-pattern scan: warn-only, category only, no raw match in wire log.
- System-prompt section via `{% if KIMI_MEMORY %}` between Project Info and Skills.
- Plan-mode policy blocks memory tool writes (operation in {write, update, delete}).
- Subagent inheritance via `prepareSystemPromptContext` re-run per spawn.
- Telemetry: `Agent.telemetry: TelemetryClient`. Events: `memory_write` / `memory_update` / `memory_delete` (payload `{ scope, slug }`, NO body); `memory_index_truncated` (payload `{ droppedCount }`). Fire-and-forget try/catch.
- Resilience: system-prompt re-render per turn + per-spawn satisfies `/compact` survival + subagent visibility-next-turn invariants. No bespoke hooks added.
- Wire type `MemoryFactSummary` (RPC payload) distinct from domain `MemoryEntry`. Domain types re-exported via `agent-core/src/index.ts` + `node-sdk/src/types.ts`.
- `listMemory` includes full body on wire (bounded). `shadowed` flag computed server-side.
- `Session.remember` mirrors `generateAgentsMd` exactly (parentToolCallId `'remember'`, origin `system_trigger:remember`).
- `MemoryBrowserApp` tested at state-machine level (no pi-tui rendering pipeline).

## Repo Conventions (must respect at commit time)

- **No co-author / no agent identity in commits or PRs** (repo `AGENTS.md:11-12`). Main agent owns Phase 5 commit.
- TS style per `AGENTS.md:33-45`.
- `#/...` subpath imports.
- `export * from './module'` in non-package `index.ts`.
- Prefer extending existing test files.
- `pnpm` not `npm`.
- Run `gen-changesets` skill before PR. Default `minor` for new features. NEVER write `major` without explicit user confirmation.

## Active sprint contract

`sprint-contract-batch-6.md` (to be written next) — scope: Task 20 only (changeset + tool description + reference doc).
