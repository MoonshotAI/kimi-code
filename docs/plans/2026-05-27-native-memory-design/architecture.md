# Architecture — Native Cross-Session Memory for kimi-code

Companion to [`_index.md`](./_index.md). Uses canonical vocabulary from the `_index.md` Glossary.

## 1. Component Map

### New files

| Path | Responsibility |
|---|---|
| `packages/agent-core/src/memory/types.ts` | `MemoryRecord`, `MemoryScope`, `MemoryType`, `MemoryEntry`, `MemoryStore` interface |
| `packages/agent-core/src/memory/store.ts` | `FileMemoryStore` — list/read/write/update/delete against `<scope-root>/.kimi-code/memory/` |
| `packages/agent-core/src/memory/loader.ts` | `loadMemory(kaos, workDir)` — mirrors `loadAgentsMd`; merges scopes; renders the index within the 8 KB budget |
| `packages/agent-core/src/memory/slug.ts` | `isValidSlug(s)`, slug validation regex |
| `packages/agent-core/src/memory/format.ts` | `parseMemoryFile(text)`, `renderMemoryFile(entry)`, `renderIndex(entries, budget)` |
| `packages/agent-core/src/memory/index.ts` | Public re-exports (`export * from './types';` etc.) |
| `packages/agent-core/src/memory/find-project-root.ts` | Shared `findProjectRoot` helper (extracted from duplication in `profile/context.ts:77` and `skill/scanner.ts:338`) |
| `packages/agent-core/src/tools/builtin/state/memory.ts` | `MemoryTool` (builtin tool, `BuiltinTool<MemoryInput>`) |
| `packages/agent-core/src/tools/builtin/state/memory.md` | Agent-facing tool description (loaded as sibling `.md`, identical pattern to `todo-list.md`) |
| `apps/kimi-code/src/tui/memory/browser.ts` | `MemoryBrowserApp` — full-screen TUI panel (list / detail / delete confirm) |
| `apps/kimi-code/src/tui/memory/state.ts` | UI state for the browser (selected scope filter, focused slug, confirm-delete) |
| `packages/agent-core/test/memory/store.test.ts` | Store-level tests (atomic writes, collision, scope merge, error paths) |
| `packages/agent-core/test/memory/loader.test.ts` | Loader / render tests (budget overflow, empty state, sort order) |
| `packages/agent-core/test/tools/memory.test.ts` | Tool surface tests (each operation, plan-mode block, secret-warning) |
| `apps/kimi-code/test/tui/memory-browser.test.ts` | TUI browser tests (list rendering, delete confirm, /remember dispatch) |

### Modified files

| Path | Change |
|---|---|
| `packages/agent-core/src/profile/types.ts:36` | Add `readonly memoryIndex?: string` to `SystemPromptContext` |
| `packages/agent-core/src/profile/context.ts:12-36` | Extend `PreparedSystemPromptContext` Pick; call `loadMemory` in `Promise.all` alongside `loadAgentsMd`; deduplicate `findProjectRoot` (use shared helper) |
| `packages/agent-core/src/profile/resolve.ts` (around `buildTemplateVars`, ~lines 153-165) | Add `KIMI_MEMORY: context.memoryIndex ?? ''` |
| `packages/agent-core/src/profile/default/system.md` | Insert `# Memory` section under `{% if KIMI_MEMORY %}` immediately after `# Project Information` (after line 128), before `# Skills` (line 130) |
| `packages/agent-core/src/tools/builtin/index.ts:17` | Re-export `./state/memory` |
| `packages/agent-core/src/agent/tool/index.ts:357-394` | Register `new b.MemoryTool(kaos, workspace)` in the builtin tool map |
| `packages/agent-core/src/agent/permission/policies/plan.ts:80-118` | Extend plan-mode guard to block Memory writes (`operation ∈ {write, update, delete}`) |
| `packages/agent-core/src/session/index.ts` | Add `listMemory()` / `deleteMemory(scope, slug)` for TUI; add `remember(text)` modeled on `generateAgentsMd` (subagent-spawned write) |
| `packages/agent-core/src/skill/scanner.ts:338-347` | Replace inline `findProjectRoot` with import from shared helper |
| `packages/agent-core/src/rpc/core-api.ts` + `core-impl.ts` + `session/rpc.ts` | Add RPC entries for `listMemory` / `deleteMemory` / `remember` (mirror `generateAgentsMd` plumbing) |
| `packages/node-sdk/src/session.ts` | Add `listMemory()`, `deleteMemory(scope, slug)`, `remember(text)` SDK wrappers |
| `apps/kimi-code/src/tui/commands/registry.ts` | Insert `{ name: 'memory', aliases: [], description: 'Browse and manage stored memory', priority: 70 }` and `{ name: 'remember', aliases: [], description: 'Ask the agent to remember something', priority: 80 }` |
| `apps/kimi-code/src/tui/kimi-tui.ts` | Add `case 'memory':` and `case 'remember':` to the dispatch switch (~line 1586); add `handleMemoryCommand` (mounts `MemoryBrowserApp`) and `handleRememberCommand` (synthesizes user prompt, mirrors `handleInitCommand` queueing flow) |

## 2. Data Structures

```ts
// packages/agent-core/src/memory/types.ts

export type MemoryScope = 'user' | 'project';
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** Frontmatter persisted in each per-fact .md file. */
export interface MemoryRecord {
  readonly name: string;          // canonical kebab-case slug; equals basename without `.md`
  readonly description: string;   // single line, <= 240 chars
  readonly type: MemoryType;
}

/** A loaded fact: frontmatter + body + provenance. */
export interface MemoryEntry {
  readonly record: MemoryRecord;
  readonly body: string;          // post-frontmatter markdown, trimmed, <= 4 KB
  readonly scope: MemoryScope;
  readonly path: string;          // absolute path to <slug>.md
}

/** A rendered, budgeted index for system-prompt injection. */
export interface MemoryIndex {
  readonly rendered: string;                    // <= 8 KB; '' when empty
  readonly entries: readonly MemoryEntry[];     // contributing facts (after merge + override)
  readonly droppedSlugs: readonly string[];     // dropped due to budget
}

export interface MemoryStore {
  list(scope: MemoryScope): Promise<readonly MemoryEntry[]>;
  read(scope: MemoryScope, slug: string): Promise<MemoryEntry | undefined>;
  write(scope: MemoryScope, record: MemoryRecord, body: string): Promise<MemoryEntry>;
  update(
    scope: MemoryScope,
    slug: string,
    patch: {
      readonly record?: Partial<MemoryRecord>;
      readonly body?: string;
    },
  ): Promise<MemoryEntry>;
  delete(scope: MemoryScope, slug: string): Promise<boolean>;
  rootFor(scope: MemoryScope): string;  // absolute root path; not guaranteed to exist
}
```

Extension to `SystemPromptContext` (`packages/agent-core/src/profile/types.ts:36`):

```ts
export interface SystemPromptContext {
  readonly osEnv: Environment;
  readonly cwd: string;
  readonly now?: string | Date;
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly memoryIndex?: string;          // NEW — rendered, budgeted block
  readonly skills?: SkillRegistry | string;
  readonly additionalDirsInfo?: string;
  readonly roleAdditional?: string;
}
```

`PreparedSystemPromptContext` (`profile/context.ts:12`) gains `'memoryIndex'` in its `Pick`.

## 3. Path Resolution Algorithm

Mirror `loadAgentsMd` (`profile/context.ts:38-75`). Simpler than skills / AGENTS.md — no walk between cwd and project root, only two fixed locations.

```text
async function loadMemory(kaos, workDir) -> string:
  userRoot           = join(home, '.kimi-code', 'memory')
  projectRoot        = findProjectRoot(kaos, workDir) || workDir
  projectMemoryRoot  = join(projectRoot, '.kimi-code', 'memory')

  bySlug = new Map<string, MemoryEntry>()

  # User scope first; project scope second so it overwrites on collision.
  for (scope, root) in [('user', userRoot), ('project', projectMemoryRoot)]:
    if not isDir(root): continue
    for file in sorted(readdir(root)):
      if not file.endsWith('.md'): continue
      if file == 'MEMORY.md': continue     # reserved filename — never treated as a fact
      slug = file.slice(0, -3)
      if not isValidSlug(slug):
        onWarning(...)
        continue
      entry = parseMemoryFile(scope, join(root, file))
      if entry is undefined: continue       # malformed — skip with warning
      if entry.record.name != slug:
        onWarning('slug ≠ filename')
        continue
      bySlug.set(slug, entry)               # project overrides user

  return renderIndex(sortedBySlug(bySlug.values()), MEMORY_INDEX_MAX_BYTES = 8 * 1024)
```

`prepareSystemPromptContext` becomes:

```ts
const [cwdListing, agentsMd, memoryIndex] = await Promise.all([
  listDirectory(kaos, resolvedCwd),
  loadAgentsMd(kaos, resolvedCwd),
  loadMemory(kaos, resolvedCwd),
]);
return { cwd: resolvedCwd, cwdListing, agentsMd, memoryIndex };
```

Subagent inheritance is automatic — `session/subagent-host.ts:286` already re-runs `prepareSystemPromptContext(kaos, cwd)` per spawn.

## 4. Builtin Tool Spec — `Memory`

Modeled on `TodoListTool` (single tool, multi-mode dispatch via a discriminant) with file-mutation discipline from `EditTool` (atomic writes, path validation).

### JSON Schema

```ts
// packages/agent-core/src/tools/builtin/state/memory.ts

const MemoryRecordSchema = z.object({
  name: z.string().min(1).max(64)
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'must be kebab-case (lowercase, digits, hyphens; 1-64 chars; no leading/trailing hyphen)'),
  description: z.string().min(1).max(240),
  type: z.enum(['user', 'feedback', 'project', 'reference']),
});

const MemoryScopeSchema = z.enum(['user', 'project']);

export const MemoryInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('view') }),
  z.object({
    operation: z.literal('list'),
    scope: MemoryScopeSchema.optional(),
    type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
  }),
  z.object({
    operation: z.literal('read'),
    scope: MemoryScopeSchema,
    name: z.string(),
  }),
  z.object({
    operation: z.literal('write'),
    scope: MemoryScopeSchema,
    record: MemoryRecordSchema,
    body: z.string().max(4096),
  }),
  z.object({
    operation: z.literal('update'),
    scope: MemoryScopeSchema,
    name: z.string(),
    record: MemoryRecordSchema.partial().optional(),
    body: z.string().max(4096).optional(),
  }),
  z.object({
    operation: z.literal('delete'),
    scope: MemoryScopeSchema,
    name: z.string(),
  }),
]);
```

### Scope is explicit (not auto-inferred)

`scope` is required on `read` / `write` / `update` / `delete`. `view` (no params) returns the merged index. `list` accepts optional `scope` / `type` filters. Rationale: an auto-infer mode masks where a fact lives and makes deletion ambiguous when both scopes hold the same slug.

### Per-operation behavior

| Operation | Output | Error modes |
|---|---|---|
| `view` | Same rendered index already in the system prompt. Useful for re-reading after a mutation. | — |
| `list` | Markdown list grouped by scope: `## Project` / `## User`, each line `- <slug> (<type>) — <description>`. Returns the full untruncated listing even when the injected index was budget-truncated. | — |
| `read` | Markdown of the fact: frontmatter (as YAML block) + body. | `NOT_FOUND` with resolved path; `SCOPE_DIR_MISSING` |
| `write` | `Wrote memory <slug> to <scope>.` + the rendered new line. | `INVALID_SLUG`, `BODY_TOO_LARGE`, `EXISTS` (suggests `update`), `IO_ERROR`, `PATH_OUTSIDE_WORKSPACE` |
| `update` | Confirmation + new rendered line. Partial frontmatter merges with existing values. | `NOT_FOUND`, `BODY_TOO_LARGE`, `INVALID_SLUG` |
| `delete` | `Deleted memory <slug> from <scope>.` | `NOT_FOUND` (idempotent — also acceptable to return `false`/no-op; design choice: surface `NOT_FOUND` so the agent learns) |

### Description doc (`memory.md`) outline

- **When to use**: durable cross-session facts (preferences, project conventions, decisions, recurring user corrections).
- **When NOT to use**: turn-scoped context; long content (use a Skill or `AGENTS.md`); secrets.
- **Scope guidance**: `project` for repo-specific facts; `user` for personal preferences. Project overrides User on slug collision.
- **Operation reference**: each `operation` with one-line example.
- **Hygiene**: prefer `update` over `write` when refining; delete superseded facts; keep `description` < 80 chars when possible.
- **Project memory may be committed to git** — note users may wish to gitignore `.kimi-code/memory/` for personal/sensitive content.
- **Subagent visibility timing**: a subagent's write becomes visible to its parent only on the next turn (when the parent re-renders its system prompt).

### Approval surface

The tool's writes target paths inside `~/.kimi-code/memory/` or `<project>/.kimi-code/memory/`. `accesses: ToolAccesses.readWriteFile(path)` ensures the standard permission policy applies. In YOLO/auto modes the tool executes silently; in default mode the operation appears in the approval log.

## 5. Slash-Command Wiring — `/memory` and `/remember`

### Registry entries (`apps/kimi-code/src/tui/commands/registry.ts`)

```ts
{ name: 'memory',   aliases: [], description: 'Browse and manage stored memory',      priority: 70 },
{ name: 'remember', aliases: [], description: 'Ask the agent to remember something', priority: 80 },
```

### Dispatch (`apps/kimi-code/src/tui/kimi-tui.ts` ~line 1586)

```ts
case 'memory':
  void this.handleMemoryCommand(args);
  return;
case 'remember':
  void this.handleRememberCommand(args);
  return;
```

### `/memory` — full-screen browser

Rationale: list → detail → delete-confirm is a 3-state navigation flow with multi-line bodies — the shape served by `TasksBrowserApp` at `kimi-tui.ts:4552-4620`. Inline `PermissionSelectorComponent` is rejected (flat 1-of-N is too thin).

`handleMemoryCommand` mirrors `showTasksBrowser`:

1. Load both scopes via `session.listMemory()` (new SDK call).
2. Bail if a browser is already mounted.
3. Mount `MemoryBrowserApp` as alt-screen takeover (saved children + `state.ui.clear()` + `addChild`).
4. Keybindings:
   - `↑/↓` navigate
   - `Enter` toggle detail pane (read-only body view)
   - `d` open delete-confirm prompt
   - `s` filter by scope (`all`/`user`/`project`)
   - `Esc`/`q` close and restore editor
5. Delete dispatches via `session.deleteMemory(scope, slug)` → RPC → `FileMemoryStore.delete`. List refreshes after each mutation.
6. **No write/edit affordances** — writes are tool-only by design.

The browser does **not** poll on a timer (unlike Tasks); memory mutates only on explicit tool calls or `/memory delete`.

Sub-arg dispatch (polish, optional v1):
- `/memory` → opens browser.
- `/memory list` → prints the merged listing inline (no full-screen).

### `/remember <text>` — agent-routed write

Mirrors `handleInitCommand` (`kimi-tui.ts:5601-5627`) which calls `session.init()`:

1. `session.remember(text)` spawns a subagent (modeled on `generateAgentsMd` at `session/index.ts:252`) with a prompt: "The user asked you to remember: `<text>`. Pick an appropriate `name` (kebab-case), `description` (≤240 chars), `type` (user/feedback/project/reference), and `scope` (user/project). Call the Memory tool with `operation: 'write'`."
2. After completion, `appendSystemReminder` notes the new fact (variant: `'memory'`).
3. The TUI returns control with the spinner reset, identical to `/init`.

This keeps memory writes single-sourced through the agent path.

## 6. Index Format (rendered, not persisted)

The injected block. Rendered each `prepareSystemPromptContext` call from per-fact files. `MEMORY.md` is a **reserved filename** — the loader explicitly skips it, so users see no surprise if they create one, and we may persist a snapshot later.

```text
<!-- kimi-code memory index — v1 -->
<!-- Generated from per-fact .md files. Edit facts, not this section. -->

## Project (<project-root>/.kimi-code/memory)
- [project-build-cmd](project-build-cmd.md) (project) — Use pnpm not npm.
- [coding-style](coding-style.md) (reference) — Biome with 2-space indent.

## User (~/.kimi-code/memory)
- [tone-preference](tone-preference.md) (user) — Prefer concise answers.
- [no-emoji](no-emoji.md) (feedback) — Never use emojis in output.
```

Rules:

- Section order: **Project, then User** (project first so override winners read top-down).
- Per-entry line: `- [<slug>](<slug>.md) (<type>) — <description>`.
- Description is the frontmatter `description` verbatim (already capped to 240 chars at parse time).
- On scope collision, only the project entry is rendered. The user-scope fact stays on disk; `/memory` shows it with a "shadowed" indicator.
- Budget overflow: drop User entries first (in reverse-alpha order), then Project entries (reverse-alpha) until under 8 KB. Append `<!-- truncated: N entries omitted; call Memory.list for the full set -->`.
- Empty merged set: return `""`. The system-prompt `{% if KIMI_MEMORY %}` guard elides the entire section.

## 7. Per-fact File Format

Path: `<scope-root>/<slug>.md`. Slug equals the frontmatter `name`, equals the basename without `.md`.

```markdown
---
name: project-build-cmd
description: Use pnpm not npm for installs and scripts.
type: project
---

This repository uses pnpm exclusively. Do not invoke npm or yarn. The
relevant scripts live in package.json at the root and in each workspace.

Build entrypoints:
- pnpm -w build
- pnpm -w test
```

Conventions:

- Frontmatter fenced by `---` (identical to Skills), parsed via **reused** `parseFrontmatter` from `packages/agent-core/src/skill/parser.ts:81-104`.
- Required keys: `name`, `description`, `type`. Extra keys tolerated but ignored (with a warning).
- `name` MUST equal the file's slug. Mismatch → loader skips with warning; tool refuses on write.
- Body: UTF-8 Markdown, trimmed, ≤ 4 KB measured by `Buffer.byteLength`. Larger bodies rejected on write.
- Flat layout (no nested dirs under the scope root) — matches the Skill flat-`.md` layout (`scanner.ts:172-194`).

## 8. Atomic Write Strategy

The store mutates exactly one file per write/update/delete because the index is **not persisted**. Eliminates dual-write hazards entirely.

### Per-fact write

```ts
async function atomicWriteText(kaos, finalPath, contents) {
  const dir = dirname(finalPath);
  await kaos.mkdir(dir, { parents: true, existOk: true });
  const tmpPath = join(dir, `.tmp-${randomHex(8)}-${basename(finalPath)}`);
  await kaos.writeText(tmpPath, contents);
  await kaos.rename(tmpPath, finalPath);  // POSIX-atomic on same FS
}
```

A crash mid-write leaves either the previous fact intact or the new one. The index is recomputed from disk on next render, so it cannot diverge from bodies.

Windows: rely on Kaos's rename abstraction. If `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` is not yet supported, fall back to delete-then-rename with a sentinel orphan name.

### Concurrency

In-process: single-flight via per-store async lock keyed by `${scope}:${slug}`. Two writes to the same slug serialize; different slugs proceed in parallel.

Cross-process (multiple `kimi-code` instances on the same repo): out of scope for v1 — last-writer-wins on bodies; the index always recomputes correctly because it reads bodies fresh.

### Delete

Plain `kaos.rm(path)`. If the file is missing, return `false`. No tmp file involved.

## 9. System-Prompt Integration

`packages/agent-core/src/profile/default/system.md` gains a new section inserted between `# Project Information` (line 128) and `# Skills` (line 130):

```markdown
{% if KIMI_MEMORY %}

# Memory

You have persistent, cross-session memory composed of small Markdown facts. Each fact lives in its own file under `<scope>/.kimi-code/memory/` and is summarized in the index below. Two scopes exist:

- **User** (`~/.kimi-code/memory/`) — preferences that follow the user across all projects.
- **Project** (`<project-root>/.kimi-code/memory/`) — facts specific to this repository. Project entries override User entries on slug collision.

Use the `Memory` tool to:
- `read` the full body of a fact before relying on it,
- `write` a new fact when the user asks you to remember something,
- `update` a fact when refining it (prefer this over creating a near-duplicate),
- `delete` a fact when it is wrong or no longer relevant.

Do not write transient turn-scoped state into memory. Treat memory as long-lived user/project knowledge, complementary to `AGENTS.md` (project documentation) and Skills (reusable procedures).

`````````
{{ KIMI_MEMORY }}
`````````
{% endif %}
```

Template var added at `packages/agent-core/src/profile/resolve.ts` (`buildTemplateVars`):

```ts
KIMI_MEMORY: context.memoryIndex ?? '',
```

## 10. Integration with Existing Systems

### vs `AGENTS.md`
- `AGENTS.md` is project documentation, version-controlled, human-authored, dir-scoped. Memory is agent-writable, scope-flat (per scope), runtime-managed.
- `loadAgentsMd` and `loadMemory` are siblings, computed in parallel.
- Adjacent template sections; the prompt distinguishes them explicitly.

### vs Skills
- Skills are procedures (how to do X); memory holds facts (what the user wants).
- Same directory convention (`<scope>/.kimi-code/<thing>/`); same scope precedence (Project > User).
- Frontmatter parsing **reuses** `parseFrontmatter` from `skill/parser.ts`. Type taxonomy differs.

### vs Compaction
Memory is injected via the system prompt, not the conversation history. `/compact` rewrites the history, not the system prompt — memory automatically survives. The renderer is re-invoked with the same `SystemPromptContext` on the next turn.

### vs the `injection` subsystem
We deliberately do **not** use `DynamicInjector`. Memory belongs in the system prompt so it is stable across `/compact` and across subagent spawns without bespoke injector wiring.

### vs commit attribution rules
The repo constraint forbids agent attribution in commits. The memory subsystem touches no commit machinery. Filesystem writes are confined to `.kimi-code/memory/` and never touch `.git/`.

## 11. Edge Cases

| Case | Behavior |
|---|---|
| Empty memory dir / dir absent | `loadMemory` returns `""`; template `{% if %}` elides the section. No tool error. |
| Malformed frontmatter | Loader skips the file and calls `onWarning`. Tool's `read`/`update`/`delete` on that slug surface `NOT_FOUND` with a hint pointing at the file. |
| `name` ≠ filename | Reject on write (`INVALID_SLUG`); skip with warning on load. |
| Slug collision across scopes | Project wins in the rendered index. Both files remain on disk. `list` exposes both when scope is explicit; `view` shows only the project entry. `/memory` browser shows both with a "shadowed" tag. |
| Index larger than 8 KB | Truncate by dropping User entries first (reverse-alpha), then Project entries (reverse-alpha) until under 8 KB. Append sentinel comment. `list` returns the untruncated listing. |
| Body > 4 KB on write | Reject with `BODY_TOO_LARGE`. |
| Concurrent writes (main + subagent, same slug) | In-process lock serializes; last write wins. |
| Concurrent writes (different slugs) | Proceed in parallel; tmp-rename per-file atomicity. |
| Delete last fact in a scope | Scope's section vanishes from the next rendered index. Directory remains (no automatic cleanup). |
| Reserved filename (`MEMORY.md`) | Loader skips it explicitly; tool refuses writes targeting that slug. |
| User home unavailable (headless CI) | `kaos.gethome()` already trusted by `context.ts:55`; same fallback semantics. If it throws, warn and proceed with project-only memory. |
| Project root differs between turns (cwd change) | `loadMemory` runs per `prepareSystemPromptContext` call. Cwd changes within a single turn are not re-detected — same limitation as `loadAgentsMd`. |
| Symlink inside memory dir | Refused on read with a clear error (no `realpath` follow). |
| Slug containing path separators or `..` | `isValidSlug` rejects. Defense-in-depth: write path composed via `join(rootFor(scope), slug + '.md')` then passed through `isWithinDirectory` (mirrors `edit.ts:68-72`). |

## 12. Open Architectural Risks

Carried forward from `_index.md` Open Risks; resolution decisions live with the plan-writing phase.

1. **gitignore policy for `.kimi-code/memory/`** — document recommendation, do not auto-write `.gitignore`.
2. **Index budget overflow handling** — silent drop + sentinel + telemetry counter `memory_index_truncated` (v1); LRU rotation deferred.
3. **`type` × `scope` cross-product** — accepted in v1; canonical pairings documented in `memory.md`.
4. **Subagent write visibility timing** — visible to parent on the **next** turn (not within the same turn). Acceptable; documented.
5. **External-editor edits while agent calls `update`** — last-writer-wins via tmp-rename in v1. Optimistic concurrency stamping deferred to v2.
6. **Should `MEMORY.md` be persisted on disk?** — v1: **render-only**. May add `kimi memory dump` CLI later.
7. **Telemetry events** — emit `memory_write`, `memory_update`, `memory_delete`, `memory_truncated` (matches the `track('init_complete')` pattern at `kimi-tui.ts:5612`). Recommended; not strictly contractual.

## Anchor Citations

- `loadAgentsMd` pattern — `packages/agent-core/src/profile/context.ts:38-75`
- `SystemPromptContext` — `packages/agent-core/src/profile/types.ts:36-45`
- Template vars — `packages/agent-core/src/profile/resolve.ts:140-166`
- System-prompt slots — `packages/agent-core/src/profile/default/system.md:120-128,95-102`
- Skill scanner scope layering — `packages/agent-core/src/skill/scanner.ts:73-94`
- Frontmatter parser to reuse — `packages/agent-core/src/skill/parser.ts:81-104`
- Builtin tool template — `packages/agent-core/src/tools/builtin/state/todo-list.ts:89-133` + `todo-list.md`
- File-mutation patterns — `packages/agent-core/src/tools/builtin/file/edit.ts:67-78,118-122`
- Path safety helpers — `packages/agent-core/src/tools/policies/path-access.ts`
- Builtin tool registration — `packages/agent-core/src/agent/tool/index.ts:357-394`
- Builtin re-exports — `packages/agent-core/src/tools/builtin/index.ts:17`
- Slash command registry — `apps/kimi-code/src/tui/commands/registry.ts:1-161`
- Slash dispatch — `apps/kimi-code/src/tui/kimi-tui.ts:1583-1588`
- `/init` flow to model `/remember` on — `apps/kimi-code/src/tui/kimi-tui.ts:5601-5627`, `packages/agent-core/src/session/index.ts:252-280`
- Full-screen browser template — `apps/kimi-code/src/tui/kimi-tui.ts:4552-4620`
- Subagent inheritance call site — `packages/agent-core/src/session/subagent-host.ts:286`
- Plan-mode permission policy — `packages/agent-core/src/agent/permission/policies/plan.ts:80-118`
- Hook event types — `packages/agent-core/src/agent/hooks/types.ts:3-17`
- `.kimi-code` root conventions — `packages/agent-core/src/skill/scanner.ts:8-11`
