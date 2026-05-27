# Best Practices — Native Cross-Session Memory

Companion to [`_index.md`](./_index.md). Uses canonical vocabulary from the `_index.md` Glossary.

## Security

**Path traversal prevention.** Reuse `canonicalizePath` + `isWithinDirectory` + `PathSecurityError` from `packages/agent-core/src/tools/policies/path-access.ts`. Do not roll your own. Treat each scope's memory directory as a workspace root for the Memory tool. Any operation resolves the candidate path lexically and then verifies it stays inside the scope's root. Mirror `WriteTool`'s pattern: throw `PathSecurityError`, return `{ isError: true, output: <message> }` from `execute`.

**Slug whitelist regex.** `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`. Lowercase only, digits and hyphens, 1–64 chars, no leading/trailing hyphen. Reject anything else **before** touching the filesystem. This single check eliminates `..`, slashes, backslashes, dots, spaces, control characters, and Windows reserved names.

**Reserved filename.** Loader skips `MEMORY.md` explicitly so a user who manually creates one does not see it ingested as a fact. The Memory tool refuses writes targeting the slug `memory` to keep the reserved name available for a future on-disk index dump.

**Secret detection (warn, do not block).** Keep the pattern list small and high-precision to minimize false positives. Recommended starter patterns (mirror the spirit of `tools/policies/sensitive.ts`):

- `sk-[A-Za-z0-9-]{20,}` — Anthropic / OpenAI-style keys
- `gh[pousr]_[A-Za-z0-9]{36}` — GitHub tokens
- `AKIA[0-9A-Z]{16}` — AWS access key id
- `-----BEGIN [A-Z ]*PRIVATE KEY-----` — private keys (pem)
- `xox[baprs]-[A-Za-z0-9-]{10,}` — Slack

On match, the write **succeeds** but the tool result `output` includes a warning naming the pattern category. The wire log records the category only — never the raw matched value. Do not enforce in v1; document the user's responsibility.

**Plan-mode write block.** Extend `PlanModeGuardPermissionPolicy` (`packages/agent-core/src/agent/permission/policies/plan.ts:80-118`) to also block the Memory tool when `operation ∈ {write, update, delete}`. Read operations (`view`, `list`, `read`) pass through. The existing pattern (matching `Write` / `Edit`, returning `{ kind: 'result', result: { block: true, reason } }`) is the right shape.

**Symlink handling.** Path policies in this repo are explicitly lexical (no `realpath`) — see the comment in `tools/policies/path-access.ts`. For memory specifically: when opening any file inside a scope directory, `stat` it and refuse if it is a symlink. Kaos does not currently expose `realpath`, so do not pretend to follow safely — refusing is the safe default. Document this; do not invent infrastructure.

**Frontmatter validation.** Required keys: `name`, `description`, `type ∈ {user, feedback, project, reference}`. Validate with the zod schema in `MemoryRecordSchema`. Reject early; never persist invalid frontmatter even partially.

## Performance

**Lazy index loading.** Mirror `loadAgentsMd`'s shape: read both scope directories only when `prepareSystemPromptContext` runs. Do not pre-warm at session construction. The `kaos.gethome()` + `findProjectRoot` + `stat` sequence is cheap; replicate it.

**Bodies are never preloaded.** Only `view` / `list` touch the per-scope directories at session start (for index assembly); only `read` / `update` / `delete` open a body, one at a time, on explicit Memory tool invocation. This is the whole point of the index design — protect it.

**Index byte budget (8 KB) and truncation order.** When the merged rendered index exceeds 8 KB:

1. Compute byte length per entry (slug + type + description, no body).
2. Drop User entries first, in reverse-alpha order, until under budget.
3. If still over budget, drop Project entries in reverse-alpha order.
4. Append the sentinel: `<!-- truncated: N entries omitted; call Memory.list for the full set -->`.

Do not split mid-entry. Mirror `renderAgentFiles` in `profile/context.ts` for the budgeting loop structure, but keep it simpler — AGENTS.md has 32 KB; memory has 8 KB.

**Concurrency.** v1: single-writer assumption per process. The agent is the only writer in a session; the slash command UI emits a prompt that triggers the tool, so writes serialize through the agent loop. **Do not add lockfiles in v1.** Document the assumption. If two `kimi-code` instances target the same repo, last-writer-wins on bodies; the index always recomputes correctly because it reads bodies fresh.

In-process: per-store async lock keyed by `${scope}:${slug}` serializes same-slug writes. Different-slug writes proceed in parallel.

**Atomic write pattern.** For each write / update:

1. Write body to `.tmp-<rand>-<slug>.md` in the same scope dir.
2. `kaos.rename(tmpPath, finalPath)` — POSIX-atomic on the same filesystem.

For delete: plain `kaos.rm(path)`. Missing file → return `false` (idempotent).

The index is **not persisted** in v1, so there is no dual-write hazard. The index is recomputed from disk on every `prepareSystemPromptContext` call.

Surface I/O failures with the same error shape `WriteTool` uses (`ENOENT` → actionable message; other errors → `error.message`).

## Code Quality (kimi-code-specific)

**Match `todo-list.ts` structurally.** New file `packages/agent-core/src/tools/builtin/state/memory.ts` next to `todo-list.ts`. Same exports pattern: `MemoryInputSchema`, `class MemoryTool implements BuiltinTool<MemoryInput>`. Description sourced from sibling `memory.md` (the markdown loader resolves automatically). Re-export from `tools/builtin/index.ts:17` alongside `state/todo-list`.

**Match `loadAgentsMd` for the loader.** New module `packages/agent-core/src/memory/loader.ts` exporting `loadMemory(kaos, workDir): Promise<string>`. Reuse `findProjectRoot` (currently private and duplicated in `profile/context.ts` and `skill/scanner.ts` — extract to a shared helper in `packages/agent-core/src/memory/find-project-root.ts` and update both callers).

**Wiring in `agent/tool/index.ts`** (around line 372 next to `new b.TodoListTool(...)`):

```ts
new b.MemoryTool(kaos, workspace),
```

The tool needs `kaos` for I/O and `workspace.workspaceDir` to derive the project memory directory. It does **not** need `ToolStore` — memory is on-disk, not session state.

**System-prompt template variable.** Add `KIMI_MEMORY` to `buildTemplateVars` in `packages/agent-core/src/profile/resolve.ts` (next to `KIMI_AGENTS_MD`). Add a corresponding section in `packages/agent-core/src/profile/default/system.md` immediately after the AGENTS.md / Project Information block. Render nothing (empty string) when the merged index is empty; the surrounding template uses the same `{% if %}` guard pattern as `KIMI_ADDITIONAL_DIRS_INFO` (`system.md:95`) so an empty memory produces no section header at all.

**TypeScript style (root `AGENTS.md:33-45`):**

- Optional properties use `name?: string`, never `name?: string | undefined`.
- Pass-through with `{ scope }` — never `{ ...(scope ? { scope } : {}) }`.
- Internal single-param methods stay single-param. Do not promote `slug: string` to `{ slug: string }`.
- Imports use `#/...`, not relative `../../../`.
- `export * from './module'` in non-package `index.ts` files.

**Test file hygiene.** Per root `AGENTS.md` ("do not add too many new test files"): add memory tool tests to `test/tools/memory.test.ts` only because no sibling test file covers the same surface. Memory loader tests **extend** `test/profile/context.test.ts` (which already covers `loadAgentsMd`). Plan-mode block tests **extend** the existing plan-policy test file, not a new one. Browser tests live in `apps/kimi-code/test/tui/memory-browser.test.ts` because no `kimi-tui` test file exists for that shape.

**Commit conventions:** no co-author attribution, no agent identity in commit messages or PR descriptions (root `AGENTS.md:11-12`). PR title must follow conventional commits. A changeset entry is required before PR; never write `major` without explicit user confirmation.

**Slash-command wiring:**

1. Register `memory` and `remember` in `BUILTIN_SLASH_COMMANDS` (`apps/kimi-code/src/tui/commands/registry.ts`) alongside `init` and `compact`.
2. Wire `case 'memory':` and `case 'remember':` into the dispatch switch in `kimi-tui.ts` around line 1586. `memory` mounts the browser via alt-screen takeover (mirror `showTasksBrowser` at `kimi-tui.ts:4552-4620`). `remember` queues a synthesized prompt and dispatches a subagent (mirror `handleInitCommand` at `kimi-tui.ts:5601-5627`).

## Testing Strategy

Translate each Gherkin scenario in `bdd-specs.md` into a vitest `it()` whose description is the scenario name (e.g. `it('writes a fact and creates the body file atomically', ...)`).

**Fixtures.** Reuse the `mkdtemp` + `vi.spyOn(localKaos, 'gethome')` mock pattern from `packages/agent-core/test/profile/context.test.ts`. Create both a fake home and a fake project root per test; clean up in `afterEach`.

**Atomic-write tests.** For "index recomputes correctly after a partial write", inject a Kaos stub that throws on the `rename` step. Assert the final body path does not exist afterward (only the tmp file does — which the test then cleans). Do not rely on real `kill -9`.

**Cross-scope merge tests.** Stand up both fixture directories, populate slugs, assert the merged output order (Project first, User second) and that collisions surface project-wins in the rendered index while the user-scope file remains on disk.

**Path-safety tests.** Pass `../foo`, `foo/bar`, absolute paths, control chars, uppercase, leading/trailing hyphens, the reserved `memory` slug. Assert all rejected before any I/O. Do not assert filesystem state — assert the tool returns `isError: true` with the right reason.

**Plan-mode interaction.** Extend the existing plan-policy tests to cover Memory tool blocking. Do not create a new test file just for this.

**TUI browser tests.** Test list rendering, scope filtering, delete-confirm flow, and the `/remember` → subagent dispatch sequence. Use the existing `TasksBrowserApp` test scaffolding (if present) as a template; otherwise build minimal scaffolding shared with future browser tests.

## Common Pitfalls

- **Do not conflate memory with `AGENTS.md`.** AGENTS.md is user-authored static project instructions. Memory is agent-managed dynamic facts. They sit next to each other in the system prompt but have independent lifecycles, loaders, and templates. Keep `loadAgentsMd` and `loadMemory` as parallel functions, not one merged loader.
- **Do not auto-write on `SessionEnd` in v1.** Writes must be explicit Memory tool calls. Predictability beats magic; auto-summarization can be added later behind a flag.
- **Do not preload bodies.** If you find yourself reading every `.md` body at session start, you have defeated the entire index design.
- **Do not pluralize the tool name.** It is `memory` (singular), to match `todo-list`, `write`, `read`. Not `memories`.
- **Do not store secrets.** Detect, warn, log — but do not block in v1. Document that the user is responsible.
- **Do not allow silent overwrite.** `write` to an existing slug fails with `EXISTS`; the agent must explicitly call `update`. Silent overwrite is a footgun and indistinguishable from a stale-cache bug.
- **Project memory may be committed to git.** Document this clearly in the Memory tool's `memory.md` description. Suggest `.gitignore` opt-out for personal/sensitive content. Do **not** auto-write `.gitignore` entries.
- **Do not invent vocabulary.** Use canonical labels from the `_index.md` Glossary exactly. Specifically: not "store", not "kb", not "knowledge base", not "entry" (other than the TS type `MemoryEntry`), not "namespace" instead of "scope".
- **Do not couple to `ToolStore`.** Unlike `TodoListTool`, memory lives on disk, not in agent-level session state. Bodies survive process exit by design.
- **Subagent context inherits automatically.** Subagents call `prepareSystemPromptContext` independently (`session/subagent-host.ts:286`). This automatically gives them the index. Do not pass memory state through `spawn` arguments.
- **Render-only `MEMORY.md` in v1.** Do not write a `MEMORY.md` to disk in v1. The index is rendered each prompt build. If you find yourself implementing a persisted `MEMORY.md`, stop — that introduces the dual-write hazard the design explicitly avoids.
- **Subagent write visibility lags one turn.** A subagent's `write` is visible to its parent only on the parent's next turn. Document this in the Memory tool description so the agent does not expect intra-turn coherence.

## Migration / Rollout

- New feature, no migration required.
- Opt-in by use: users get memory the moment the agent calls the Memory tool.
- No config flag in v1 (no opt-out beyond not asking the agent to write).
- Document the `.kimi-code/memory/` convention in the Memory tool's `memory.md` description, including the `.gitignore` suggestion for users who want project memory to stay personal.
- Update root `AGENTS.md`? **No** — reserved for hot-path rules. Document memory in a short doc under `docs/` and reference it from `memory.md` so the agent itself knows the conventions.
- Changeset entry: **`minor` bump** (new feature, no breaking changes). Do not write `major` without explicit user agreement (per root `AGENTS.md` hard rule).
- Telemetry events to emit: `memory_write`, `memory_update`, `memory_delete`, `memory_truncated`. Match the `track('init_complete')` pattern at `kimi-tui.ts:5612`.
