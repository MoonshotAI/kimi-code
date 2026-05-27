# Native Cross-Session Memory for kimi-code — Design

**Date**: 2026-05-27
**Topic**: Add native cross-session memory to kimi-code with a file-backed Markdown store, layered user/project scopes, an agent-facing `memory` builtin tool, and a `/memory` slash command for user-side curation.
**Status**: Design (Phase 2 of brainstorming pipeline)

## Context

kimi-code currently carries three forms of context across turns:

1. **Static project instructions via `AGENTS.md`.** `loadAgentsMd` (`packages/agent-core/src/profile/context.ts:38`) walks from user home down to the working directory, discovers every `AGENTS.md` / `.kimi-code/AGENTS.md` / `.agents/AGENTS.md`, dedupes, byte-budgets to 32 KB, and renders the merged result into `{{ KIMI_AGENTS_MD }}` in the system prompt (`packages/agent-core/src/profile/default/system.md:121`). Human-authored; `/init` regenerates it.
2. **Skills as reusable directories of capability** under `<scope>/.kimi-code/skills/` (`packages/agent-core/src/skill/scanner.ts:8-11`), rendered into `{{ KIMI_SKILLS }}` (`system.md:147`).
3. **JSONL session records** for resume / replay — wire log of a specific session, not consulted by future sessions.

**The gap**: nothing carries semantic facts from one session to the next except (a) the user-edited `AGENTS.md` (process-coarse, human-maintained) and (b) per-session JSONL (not cross-session). There is no agent-writable, semantic, cross-session store; no per-fact addressability; no scope merging tuned for memory; no `/memory` curation surface. Community issue [#1167](https://github.com/MoonshotAI/kimi-code/issues/1167) (closed) requested hierarchical memory and remains unimplemented — the historical kimi-code position has been "use AGENTS.md," which collapses the static-instructions axis and the dynamic-memory axis into a single human-maintained file.

**Why now / why this shape**:

- **Anthropic Memory Tool (`memory_20250818`, public beta 2025-08)** establishes the client-side files-with-primitives pattern: `view / create / str_replace / delete` against a sandboxed directory. Our tool surface aligns directly: file-backed, agent-driven, with `view / list / read / write / update / delete` operations.
- **Claude Code's `MEMORY.md` index-pointer pattern** keeps a small index permanently in context and lazily reads per-fact bodies on demand — bounds context cost (≤8 KB) while preserving recall.
- **File > vector DB at CLI agent scale.** Typical per-project memory volume is under ~50 facts; vector indexing adds binary deps and opacity with no measurable recall benefit. Plain Markdown stays grep-able, diff-able, version-controllable, zero-binary-dep.
- **Static AGENTS.md and dynamic memory are complementary, not redundant.** AGENTS.md is human-authored project policy; memory is agent-authored runtime fact. Keeping the two surfaces separate respects each one's authoring contract.

## Discovery Results

Every fact below is direct, citation-anchored evidence the design depends on:

- AGENTS.md scanner walks user-home → project-root → cwd, with `.kimi-code/AGENTS.md` checked before generic `AGENTS.md` — `packages/agent-core/src/profile/context.ts:54-72`.
- `AGENTS_MD_MAX_BYTES = 32 * 1024`, budgeted leaf-to-root in `renderAgentFiles` — `packages/agent-core/src/profile/context.ts:8,134-165`.
- `loadAgentsMd(kaos, workDir)` is the public entrypoint, re-called by `/init` after generation — `packages/agent-core/src/profile/context.ts:38`, consumed at `packages/agent-core/src/session/index.ts:267`.
- `SystemPromptContext` is the structured handoff to template rendering; `agentsMd` and `skills` are optional string fields — `packages/agent-core/src/profile/types.ts:36-45`.
- Skill scanner constants `USER_BRAND_DIRS = PROJECT_BRAND_DIRS = ['.kimi-code/skills']`; generic `.agents/skills` follows — `packages/agent-core/src/skill/scanner.ts:8-11`.
- `findProjectRoot` walks up looking for `.git` — duplicated between `packages/agent-core/src/profile/context.ts:77-87` and `packages/agent-core/src/skill/scanner.ts:338-347` (extract to shared helper as part of this work).
- system.md template variables include `KIMI_AGENTS_MD`, `KIMI_SKILLS`, `KIMI_ADDITIONAL_DIRS_INFO` — `system.md:5,72,82,86,91,101,121,147`. New `KIMI_MEMORY` slot fits between `KIMI_AGENTS_MD` (line 121) and `KIMI_SKILLS` (line 147).
- Jinja-style `{% if %}` guard pattern already in use for empty sections — `system.md:95` (for `KIMI_ADDITIONAL_DIRS_INFO`).
- Slash command registry shape: `name`, `aliases`, `description`, optional `priority`, optional `availability` — `apps/kimi-code/src/tui/commands/types.ts:5-11`; full registry at `apps/kimi-code/src/tui/commands/registry.ts:3-161`.
- `/init` dispatches in the TUI switch at `apps/kimi-code/src/tui/kimi-tui.ts:1583`; `handleInitCommand` at lines 5601-5627 calls `session.init()` and manages spinner / message queue.
- `generateAgentsMd()` orchestrates `subagentHost.spawn('coder', ...)` → completion → re-load → `appendSystemReminder` with `{ kind: 'injection', variant: 'init' }` — `packages/agent-core/src/session/index.ts:252-280`. This is the canonical orchestration pattern to clone for `/remember`.
- Builtin tool template — `TodoListTool` at `packages/agent-core/src/tools/builtin/state/todo-list.ts:89-133`, with sibling description `todo-list.md` resolved via the `.md` loader.
- File-mutation tool patterns — `EditTool` at `packages/agent-core/src/tools/builtin/file/edit.ts:67-78,118-122` (path validation, write semantics).
- Builtin tools wired at `packages/agent-core/src/agent/tool/index.ts:357-394`; each implements `BuiltinTool<Input>` with `name`, `description`, `parameters`, `resolveExecution`.
- Builtin re-exports — `packages/agent-core/src/tools/builtin/index.ts:17`.
- Hook event types include `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `Stop`, etc. — `packages/agent-core/src/agent/hooks/types.ts:3-17`. `PostCompact` fires fire-and-forget from `packages/agent-core/src/agent/compaction/full.ts:500-504`.
- Frontmatter parser already factored — `parseFrontmatter(text)` at `packages/agent-core/src/skill/parser.ts:81-104` returns `{ data, body }`. Reusable for memory.
- Plan-mode permission policy blocks writes by inspecting `agent.planMode.isActive` — `packages/agent-core/src/agent/permission/policies/plan.ts:80-118`. Memory write guard follows the same `PermissionPolicy` shape.
- Path safety helpers — `canonicalizePath`, `isWithinDirectory`, `PathSecurityError` — `packages/agent-core/src/tools/policies/path-access.ts`.
- Secret-pattern model — `packages/agent-core/src/tools/policies/sensitive.ts`.
- Subagents re-run `prepareSystemPromptContext(kaos, cwd)` per spawn — `packages/agent-core/src/session/subagent-host.ts:286`; cwd inherits from parent. Memory injection thus reaches subagents automatically.
- Full-screen browser template — `TasksBrowserApp` at `apps/kimi-code/src/tui/kimi-tui.ts:4552-4620` (mount via alt-screen takeover).
- Repo commit constraint — no co-author attribution, no agent identity in commit messages or PR descriptions — root `AGENTS.md:11-12`.
- TypeScript style constraints (root `AGENTS.md:33-45`): pass `undefined` directly for optional properties (no conditional spread); `?:` optional properties should not also allow `| undefined`; single-parameter internal methods stay single-param; `export * from './module'` in non-package `index.ts`; `import ... from '#/...'`; do not add many new test files.

## Glossary

Canonical labels for this design. All four design files (`_index.md`, `bdd-specs.md`, `architecture.md`, `best-practices.md`) use these terms exclusively. Rejected variants are listed alongside for traceability.

| Concept | Canonical label | Rejected variants |
|---|---|---|
| The system / feature | **memory** | "memory system", "knowledge base", "KB" |
| The builtin tool (prose) | **the Memory tool** | "memory tool" (lowercase) when used as proper noun |
| Tool's registered name (code) | **`memory`** | "memories", "memory-tool" |
| TypeScript class for the tool | **`MemoryTool`** | — |
| Single stored item (prose, preferred) | **fact** | "entry" (reserved for `MemoryEntry` TS type), "memo", "memory item" |
| Single stored item (prose, formal) | **memory record** | "record" alone |
| Single stored item (TS type) | **`MemoryEntry`** | — |
| Storage scope (concept) | **scope** | "namespace", "tier", "level" |
| Scope values | **`user`**, **`project`** (lowercase) | "User scope" only acceptable as section header |
| Injected system-prompt block | **index** | "header", "summary", "manifest" |
| Reserved filename for the index (logical) | **`MEMORY.md`** | "memory-index.md", "_index.md" |
| Index persistence model | **render-only in v1** (not written to disk; rendered each `prepareSystemPromptContext` call) | "persisted index" rejected — would create dual-write hazard against per-fact files |
| Persisted body file | **body** | "content", "payload" |
| Body filename pattern | **`<slug>.md`** | — |
| Identifier (kebab-case) | **slug** | "id", "key"; `name` is only the frontmatter field that equals the slug |
| Tool operation discriminator (field name) | **`operation`** | `op` |
| Operation values | **`view`**, **`list`**, **`read`**, **`write`**, **`update`**, **`delete`** | — |
| Fact `type` taxonomy | **`user`**, **`feedback`**, **`project`**, **`reference`** | — |

## Requirements

### Functional Requirements

- **FR-1**: The agent can record a fact via the Memory tool with `operation: 'write'`, providing `scope`, `record` (`name`/`description`/`type`), and `body` (Markdown ≤ 4 KB).
- **FR-2**: The agent can recall a fact's body by slug via `operation: 'read'`, returning frontmatter + body.
- **FR-3**: The agent can list facts filtered by scope and/or type via `operation: 'list'`, returning slug + description rows.
- **FR-4**: The agent can amend a fact via `operation: 'update'` (partial frontmatter merge + body replace, atomic) or remove it via `operation: 'delete'`. Update is distinct from write so the agent explicitly acknowledges overwrite.
- **FR-5**: The merged index (project overlay over user) is injected into the system prompt at session start and refreshed on every `prepareSystemPromptContext` call (including post-compact), via a new `{{ KIMI_MEMORY }}` placeholder rendered from `SystemPromptContext.memoryIndex`.
- **FR-6**: The user can browse all facts — across both scopes, grouped by scope and type — via `/memory` (full-screen TUI panel, no LLM round-trip).
- **FR-7**: The user can delete a fact via `/memory` with an explicit confirmation step.
- **FR-8**: The user can request a write via `/remember <text>`, which routes through the agent (subagent spawn modeled on `Session.generateAgentsMd`) so that slug, description, and type are LLM-derived from the free-text input. Direct user writes never bypass the agent.
- **FR-9**: On slug collision between scopes in the merged injected index, project overrides user. The user-scope fact remains on disk and addressable for `read` / `delete` when the scope is explicit; `/memory` shows both with a "shadowed" indicator.
- **FR-10**: Subagents see the same merged memory injection automatically, because subagent bootstrap re-runs `prepareSystemPromptContext` and that pipeline includes the memory loader.

### Non-Functional Requirements

- **NFR-1**: Index byte cap is 8 KB (after merge + frontmatter strip); per-fact body byte cap is 4 KB. Writes exceeding 4 KB fail with a structured error suggesting a tighter summary.
- **NFR-2**: Index is lazy-loaded; per-fact bodies are never auto-loaded into the system prompt — only fetched on `operation: 'read'`.
- **NFR-3**: Writes are atomic: write body to a tmp file inside the same scope dir, then rename. A crash mid-write leaves either the previous fact intact or the new one — never half-written. The index is recomputed from disk on next render, so it cannot diverge from bodies.
- **NFR-4**: Slug whitelist is `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` — lowercase letters, digits, hyphens; 1–64 chars; no leading/trailing hyphen. Reject before any filesystem access.
- **NFR-5**: Path-traversal-safe: no `..` segments; resolved path must stay inside the scope dir (reuse `isWithinDirectory` from `tools/policies/path-access.ts`); symlinks inside the memory dir are refused on read.
- **NFR-6**: `operation: 'write' | 'update' | 'delete'` are blocked under `/plan` mode. Enforcement mirrors `PlanModeGuardPermissionPolicy` (`agent/permission/policies/plan.ts:80`). Read operations (`view`, `list`, `read`) pass through.
- **NFR-7**: Memory survives `/compact` and session restart. The system prompt is rebuilt from disk on session start; on `/compact`, the next system prompt re-injects the index automatically (it lives in the system prompt, not in the compacted history).
- **NFR-8**: No new binary dependencies. Pure TypeScript, `node:fs` via the existing `Kaos` abstraction, and the existing `parseFrontmatter` helper.
- **NFR-9**: Tests added to existing files where the unit fits (per root `AGENTS.md`: "do not add too many new test files"). New test files reserved for the memory module surface: `test/memory/*.test.ts` and `test/tools/memory.test.ts`.

### Out of Scope (explicit non-goals)

- Vector / semantic search (deferred until per-project memory count materially crosses ~100 facts).
- Automatic write on `SessionEnd` (deferred to v2 — the hook surface stays available, no default behavior in v1: predictability over magic).
- Encryption at rest (rely on OS file permissions; documented for future hardening).
- Cross-machine sync (the user's git or their own sync tool covers project scope; user scope is per-machine by design).
- LLM-driven session summarization into memory (deferred — the agent decides what is worth remembering, mediated by an explicit Memory tool call).
- Multi-user / team-shared memory (single-user model; sharing happens by checking project scope into git).
- Persisting `MEMORY.md` to disk in v1 (rendered-only; may add `kimi memory dump` CLI later).

## Rationale

- **File-based over vector DB**: bounded scale (< 100 facts), zero binary deps, grep-able, diff-able, version-controllable. A vector DB at this scale adds binary-dep bloat plus operational opacity with no measurable recall benefit.
- **Index injection over full-content injection**: bounded context cost (8 KB vs potentially 200 KB), but preserves recall — the agent always sees what *exists* and can fetch any body on demand. Same trade-off `AGENTS.md` accepts via byte-budgeting; same model Claude Code's `MEMORY.md` uses.
- **Render-only index (not persisted to disk)**: eliminates the dual-write hazard between body files and an index file. Per-fact `.md` files are the single source of truth. The Memory tool's `view` operation returns the rendered block, so the agent can inspect the index without the index ever needing to land on disk.
- **Agent-driven writes over hook-triggered writes**: every memory write is observable in the wire log, attributable to a specific tool call, and debuggable. Hook-triggered auto-writes are easy to ship and hard to reason about; the hook surface remains free for v2.
- **Scope merge mirrors AGENTS.md and Skills (project overrides user)**: minimum surprise for users already familiar with the existing scope model.
- **Tool surface modeled on Anthropic's `memory_20250818` primitives**: portable across providers, validated by an existing public design, and easily mapped onto the `BuiltinTool<Input>` shape (one tool, dispatch on the `operation` discriminant — same pattern as `TodoListTool`).
- **`/memory` is curation-only**: writes always go through the agent, ensuring frontmatter (especially `type` and `description`) is LLM-derived and consistent. The TUI surface stays small (list + view + delete + confirm) and free of LLM coupling, keeping the dialog snappy and easy to test.
- **`/remember <text>` synthesizes a prompt instead of writing directly**: keeps writes single-sourced through the agent path (one writer, one place to audit), at the cost of one extra LLM turn vs a direct write. Worth it for consistency.

## Success Criteria

- A user runs `kimi` on a project, writes a fact (via natural conversation or `/remember`), exits, runs `kimi` again on the same project, and observes that the agent recalls the fact without the user re-explaining anything.
- All BDD scenarios in `bdd-specs.md` pass.
- No regressions in AGENTS.md merging or Skill discovery (existing tests in `packages/agent-core/test/profile/*`, `packages/agent-core/test/skill/*` remain green).
- Performance: index load < 5 ms warm cache for ≤ 50 facts; single write < 20 ms including atomic rename, measured on a developer Mac with local SSD.

## Detailed Design

See companion documents:

- [`architecture.md`](./architecture.md) — System overview, components, data structures, integration points, atomic write strategy, slash-command wiring.
- [`bdd-specs.md`](./bdd-specs.md) — Full Gherkin scenarios (happy path, edge cases, error conditions).
- [`best-practices.md`](./best-practices.md) — Security, performance, code quality, testing strategy, common pitfalls.

## Design Documents

- `_index.md` (this file) — Context, Discovery Results, Glossary, Requirements, Rationale, Success Criteria.
- `architecture.md` — Component map, data structures, path resolution, builtin tool spec, slash-command wiring, index format, per-fact format, atomic writes, system-prompt integration, edge cases, open risks.
- `bdd-specs.md` — Gherkin features covering storage layering, agent reads/writes/updates/deletes, `/memory` slash command, system-prompt injection, `/compact` and session-restart resilience, security and path safety, plan-mode interaction.
- `best-practices.md` — Security (path traversal, slug regex, secret detection, plan mode, symlinks), Performance (lazy load, body cap, index budget, concurrency, atomicity), Code Quality (TS style, file conventions, commit rules), Testing strategy, Common pitfalls, Rollout.

## Open Architectural Risks (carried forward to plan phase)

1. **gitignore policy for `.kimi-code/memory/`** — should we recommend / auto-add gitignore for project memory? Decision needed before launch. Default in design: **document recommendation; do not auto-write `.gitignore`**.
2. **Index budget overflow handling** — silent drop with telemetry counter `memory_index_truncated` (current design), or LRU rotation? v1 = silent drop + sentinel comment + counter.
3. **`type` × `scope` cross-product** — a `type: project` fact in `user` scope is technically possible. v1 = accept cross-product; document canonical pairings in the tool description.
4. **Subagent write visibility timing** — a subagent's write is visible to its parent only on the next `prepareSystemPromptContext` call (next turn). Acceptable; documented in the tool description.
5. **External-editor edits while agent calls `update`** — last-writer-wins via tmp-rename. Optimistic-concurrency stamping deferred to v2.
