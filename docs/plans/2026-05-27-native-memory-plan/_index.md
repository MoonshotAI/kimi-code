# Implementation Plan — Native Cross-Session Memory for kimi-code

**Date**: 2026-05-27
**Design**: [`../2026-05-27-native-memory-design/`](../2026-05-27-native-memory-design/) (evaluator PASS 5/5, commit `52f0c11`)
**Status**: Plan (Phase 6 of writing-plans pipeline)

## Context

kimi-code today carries information across turns only via static `AGENTS.md` injection, Skills, and per-session JSONL replay — there is no agent-writable, semantic, cross-session memory. The design folder [`2026-05-27-native-memory-design`](../2026-05-27-native-memory-design/) specifies a file-backed Markdown memory system: per-fact `.md` bodies under `~/.kimi-code/memory/` (user) and `<git-root>/.kimi-code/memory/` (project); a render-only `MEMORY.md` index injected into the system prompt; a `Memory` builtin tool with `view/list/read/write/update/delete` operations; a `/memory` TUI browser for curation; and a `/remember` slash command that routes writes through the agent.

This plan decomposes the design into RED-then-GREEN tasks, paired by BDD Feature. The 45 BDD scenarios in [`bdd-specs.md`](../2026-05-27-native-memory-design/bdd-specs.md) are the source of truth for task content and verification.

### Current vs Target State

| Dimension | Current | Target |
|---|---|---|
| Cross-session semantic store | None | `<scope>/.kimi-code/memory/<slug>.md` per-fact files (two scopes: `user`, `project`) |
| Project root resolution | Duplicated `findProjectRoot` in `profile/context.ts:77` + `skill/scanner.ts:338` | Single shared helper in `packages/agent-core/src/memory/find-project-root.ts`, reused by all three callers |
| System-prompt template vars | `KIMI_AGENTS_MD`, `KIMI_SKILLS`, `KIMI_ADDITIONAL_DIRS_INFO`, etc. | + `KIMI_MEMORY` (rendered index, ≤ 8 KB, between Project Information and Skills sections) |
| Builtin tool surface | `Read`, `Write`, `Edit`, `TodoList`, `Bash`, etc. | + `Memory` tool with `operation: view\|list\|read\|write\|update\|delete` discriminator |
| Slash commands | `/init`, `/compact`, `/sessions`, `/tasks`, `/plan`, `/yolo`, … | + `/memory` (TUI browser) and `/remember <text>` (agent-routed write) |
| Plan-mode policy | Blocks `Write`, `Edit` on non-plan paths (`agent/permission/policies/plan.ts:80`) | Also blocks Memory `write`/`update`/`delete`; read ops pass through |
| Session-level API | `init()`, `generateAgentsMd()`, … | + `listMemory()`, `deleteMemory(scope, slug)`, `remember(text)` |
| Telemetry events | `init_complete`, etc. | + `memory_write`, `memory_update`, `memory_delete`, `memory_index_truncated` |

## Goals

1. Every BDD scenario in `bdd-specs.md` is covered by at least one task and passes a test that exercises it.
2. No regressions in existing `AGENTS.md` loading or Skill discovery.
3. Atomic writes verified: a forced `rename` failure leaves the body file absent (no orphan); the index reconstructs from disk on next render.
4. Performance: index load < 5 ms warm cache for ≤ 50 facts; single write < 20 ms including atomic rename.
5. Repo conventions honored: no co-author / no agent identity in commits; changeset emitted as `minor`; `#/...` imports; no new test files beyond the listed ones.

## Architecture

Per design, dependencies point inward:

- **Domain types** (`packages/agent-core/src/memory/types.ts`): `MemoryRecord`, `MemoryScope`, `MemoryType`, `MemoryEntry`, `MemoryStore` interface. Zero external imports.
- **Store implementation** (`memory/store.ts`): `FileMemoryStore` implements `MemoryStore`; depends on `Kaos` + path-safety helpers.
- **Loader** (`memory/loader.ts`): `loadMemory(kaos, workDir)` + `renderIndex(entries, budget)`; depends on store + shared `findProjectRoot`.
- **Tool** (`tools/builtin/state/memory.ts`): `MemoryTool implements BuiltinTool<MemoryInput>`; uses the store.
- **Composition root** (`agent/tool/index.ts`): wires `new b.MemoryTool(kaos, workspace)`.
- **TUI** (`apps/kimi-code/src/tui/memory/`): depends inward via `session.listMemory()` / `session.deleteMemory()` / `session.remember()` RPC.

## Constraints

- **Repo `AGENTS.md` hard rules**: no co-author attribution; no agent identity in commits/PRs; `#/...` imports; no `?: T | undefined` (use `?: T`); single-param internal methods stay single-param; prefer extending existing test files.
- **One new test file per coherent surface only** (per repo guidance): store/loader → extend `test/profile/context.test.ts`; tool → new `test/tools/memory.test.ts`; browser → new `apps/kimi-code/test/tui/memory-browser.test.ts`.
- **No `major` changeset** without explicit user agreement — this is a new feature, `minor` bump.
- **No git mutations** beyond the plan commit emitted by Phase 5.

## Task File References

Foundation:
- [Task 001: Setup foundation (find-project-root helper + memory module skeleton)](./task-001-setup.md)

Feature pairs (test → impl):
- [Task 002 test — Storage layered scopes (loader + index render)](./task-002-loader-test.md) → [Task 002 impl](./task-002-loader-impl.md)
- [Task 003 test — Agent writes via Memory tool](./task-003-memory-write-test.md) → [Task 003 impl](./task-003-memory-write-impl.md)
- [Task 004 test — Agent reads via Memory tool](./task-004-memory-read-test.md) → [Task 004 impl](./task-004-memory-read-impl.md)
- [Task 005 test — Agent updates and deletes via Memory tool](./task-005-memory-updel-test.md) → [Task 005 impl](./task-005-memory-updel-impl.md)
- [Task 006 test — System-prompt injection](./task-006-injection-test.md) → [Task 006 impl](./task-006-injection-impl.md)
- [Task 007 test — Survives /compact and session restart](./task-007-resilience-test.md) → [Task 007 impl](./task-007-resilience-impl.md)
- [Task 008 test — Security and path safety](./task-008-security-test.md) → [Task 008 impl](./task-008-security-impl.md)
- [Task 009 test — /memory and /remember (TUI + session API)](./task-009-tui-test.md) → [Task 009 impl](./task-009-tui-impl.md)
- [Task 010 test — Telemetry events](./task-010-telemetry-test.md) → [Task 010 impl](./task-010-telemetry-impl.md)

Config / docs:
- [Task 011: Changeset entry + tool description + reference doc](./task-011-changeset.md)

## BDD Coverage

Every Feature in [`bdd-specs.md`](../2026-05-27-native-memory-design/bdd-specs.md) is covered by exactly one test/impl pair:

| BDD Feature | Scenarios | Task pair |
|---|---|---|
| Storage with layered scopes | 8 | 002 |
| Agent writes via the Memory tool | 6 | 003 |
| Agent reads via the Memory tool | 6 | 004 |
| Agent updates and deletes via the Memory tool | 5 | 005 |
| System-prompt injection | 4 | 006 |
| Survives /compact and session restart | 3 | 007 |
| Security and path safety | 5 | 008 |
| /memory slash command (TUI curation) | 6 | 009 |
| Telemetry | 2 | 010 |
| **Total** | **45** | **9 feature pairs + 1 foundation + 1 config** |

## Dependency Chain

```text
                              ┌─────────┐
                              │ 001     │  Setup foundation
                              │ setup   │  (find-project-root, types, slug, format, store iface)
                              └────┬────┘
                                   │
   ┌───────────────┬───────────────┼──────────────┬───────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
   ▼               ▼               ▼              ▼               ▼              ▼              ▼              ▼              ▼
┌──────┐        ┌──────┐        ┌──────┐       ┌──────┐        ┌──────┐       ┌──────┐       ┌──────┐       ┌──────┐       ┌──────┐
│002t  │        │003t  │        │004t  │       │005t  │        │006t  │       │007t  │       │008t  │       │009t  │       │010t  │
│loader│        │write │        │read  │       │updel │        │inject│       │resil │       │secure│       │tui   │       │telem │
└──┬───┘        └──┬───┘        └──┬───┘       └──┬───┘        └──┬───┘       └──┬───┘       └──┬───┘       └──┬───┘       └──┬───┘
   ▼               ▼               ▼              ▼               ▼              ▼              ▼              ▼              ▼
┌──────┐        ┌──────┐        ┌──────┐       ┌──────┐        ┌──────┐       ┌──────┐       ┌──────┐       ┌──────┐       ┌──────┐
│002i  │        │003i  │        │004i  │       │005i  │        │006i  │       │007i  │       │008i  │       │009i  │       │010i  │
└──┬───┘        └──┬───┘        └──┬───┘       └──┬───┘        └──┬───┘       └──┬───┘       └──┬───┘       └──┬───┘       └──┬───┘
   │               │               │              │               │              │              │              │              │
   └───────────────┴───────────────┴──────────────┼───────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
                                                  │
                                       Cross-impl prerequisites (real technical dependencies):
                                       • 006i (injection) requires 002i (loader provides the index string)
                                       • 007i (resilience) requires 006i (injection) + 003i (write seeds memory)
                                       • 008i (security)   requires 003i (write path traversal guard)
                                       • 009i (TUI)         requires 002i + 003i + 005i (session.listMemory uses loadMemory; /remember uses write; /memory delete uses delete)
                                       • 010i (telemetry)   requires 002i + 003i + 005i (events emitted in renderIndex truncation + write/update/delete)

                                                  │
                                                  ▼
                                            ┌──────────┐
                                            │ 011      │  Changeset + memory.md tool desc + docs
                                            │ config   │  depends-on: all impls
                                            └──────────┘
```

**Notes**:
- Test tasks (`NNNt`) depend only on `001` (setup) — they describe the expected behavior, no other impls required to compile (test stubs against new module signatures defined in 001).
- Impl tasks (`NNNi`) depend on their paired test, plus any **real** cross-impl prereqs listed above.
- 002t/003t/004t/005t/006t/007t/008t/009t/010t can be drafted in parallel after 001.
- 002i/003i/004i/005i can be drafted in parallel (no impl-to-impl prerequisite between them) — each modifies different module surface (loader vs three independent tool-op handlers, all gated on 001 setup).

## Execution Plan

```yaml
tasks:
  - id: "001"
    subject: "Setup foundation — find-project-root helper + memory module skeleton"
    slug: "setup"
    type: "setup"
    depends-on: []

  - id: "002-test"
    subject: "Tests for Storage with layered scopes (loader + index render)"
    slug: "loader-test"
    type: "test"
    depends-on: ["001"]
  - id: "002-impl"
    subject: "Implement loadMemory + renderIndex"
    slug: "loader-impl"
    type: "impl"
    depends-on: ["002-test"]

  - id: "003-test"
    subject: "Tests for Agent writes via the Memory tool"
    slug: "memory-write-test"
    type: "test"
    depends-on: ["001"]
  - id: "003-impl"
    subject: "Implement Memory tool write operation + FileMemoryStore.write"
    slug: "memory-write-impl"
    type: "impl"
    depends-on: ["003-test"]

  - id: "004-test"
    subject: "Tests for Agent reads via the Memory tool"
    slug: "memory-read-test"
    type: "test"
    depends-on: ["001"]
  - id: "004-impl"
    subject: "Implement Memory tool view/list/read + FileMemoryStore.list/read"
    slug: "memory-read-impl"
    type: "impl"
    depends-on: ["004-test"]

  - id: "005-test"
    subject: "Tests for Agent updates and deletes via the Memory tool"
    slug: "memory-updel-test"
    type: "test"
    depends-on: ["001"]
  - id: "005-impl"
    subject: "Implement Memory tool update/delete + FileMemoryStore.update/delete"
    slug: "memory-updel-impl"
    type: "impl"
    depends-on: ["005-test"]

  - id: "006-test"
    subject: "Tests for System-prompt injection (KIMI_MEMORY template var + section)"
    slug: "injection-test"
    type: "test"
    depends-on: ["001"]
  - id: "006-impl"
    subject: "Implement SystemPromptContext extension + buildTemplateVars + system.md template"
    slug: "injection-impl"
    type: "impl"
    depends-on: ["006-test", "002-impl"]

  - id: "007-test"
    subject: "Tests for Survives /compact and session restart"
    slug: "resilience-test"
    type: "test"
    depends-on: ["001"]
  - id: "007-impl"
    subject: "Verify and harden injection refresh path; subagent inheritance test scaffolding"
    slug: "resilience-impl"
    type: "impl"
    depends-on: ["007-test", "006-impl", "003-impl"]

  - id: "008-test"
    subject: "Tests for Security and path safety"
    slug: "security-test"
    type: "test"
    depends-on: ["001"]
  - id: "008-impl"
    subject: "Implement path-traversal guard + symlink refusal in store + plan-mode policy extension"
    slug: "security-impl"
    type: "impl"
    depends-on: ["008-test", "003-impl"]

  - id: "009-test"
    subject: "Tests for /memory (TUI browser) + /remember (agent-routed write) + session API"
    slug: "tui-test"
    type: "test"
    depends-on: ["001"]
  - id: "009-impl"
    subject: "Implement Session.listMemory/deleteMemory/remember + RPC + SDK + MemoryBrowserApp + slash registry"
    slug: "tui-impl"
    type: "impl"
    depends-on: ["009-test", "002-impl", "003-impl", "005-impl"]

  - id: "010-test"
    subject: "Tests for Telemetry (memory_write/update/delete/truncated events)"
    slug: "telemetry-test"
    type: "test"
    depends-on: ["001"]
  - id: "010-impl"
    subject: "Emit telemetry events from Memory tool ops + index renderer truncation counter"
    slug: "telemetry-impl"
    type: "impl"
    depends-on: ["010-test", "002-impl", "003-impl", "005-impl"]

  - id: "011"
    subject: "Changeset entry (minor) + memory.md tool description + reference doc"
    slug: "changeset"
    type: "config"
    depends-on: ["002-impl", "003-impl", "004-impl", "005-impl", "006-impl", "007-impl", "008-impl", "009-impl", "010-impl"]
```

## Commit Boundaries

One commit per task. The setup task (001) and each test/impl pair land as separate commits so a reviewer can read the BDD scenario, see the RED test, then the GREEN impl, in sequence. The final config task (011) lands as one commit that wires the changeset.

Per repo `AGENTS.md`: **no co-author attribution**, **no agent identity in commit messages or PR descriptions**.
