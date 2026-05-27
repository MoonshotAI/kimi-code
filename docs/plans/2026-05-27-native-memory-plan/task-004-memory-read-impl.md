# Task 004 impl — Memory tool view/list/read + FileMemoryStore.list/read

**Subject**: Implement read-side operations on the Memory tool and store.
**Type**: impl
**Depends-on**: ["004-test"]

## BDD Scenarios

```gherkin
Feature: Agent reads via the Memory tool

  Scenario: view returns the merged index
    Given the project scope contains fact "build" and the user scope contains fact "style"
    When the agent calls the Memory tool with operation "view"
    Then the output lists both facts grouped by scope
    And each fact line shows slug, type, and description (not body)
    And the rendered output fits within the 8 KB index budget

  Scenario: list filters by type
    Given the project scope contains facts of types "project" and "reference"
    When the agent calls the Memory tool with operation "list" and type "reference"
    Then only "reference"-typed slugs are returned

  Scenario: list filters by scope
    Given facts exist in both scopes
    When the agent calls the Memory tool with operation "list" and scope "user"
    Then only user-scope slugs are returned

  Scenario: list returns the full untruncated set even when the injected index was truncated
    Given 200 small facts exist in the project scope, totaling more than 8 KB rendered
    And the injected index was budget-truncated
    When the agent calls the Memory tool with operation "list" and scope "project"
    Then the output contains every project-scope slug

  Scenario: read returns the full body of a named fact
    Given a fact "build" exists in the project scope with body "pnpm build"
    When the agent calls the Memory tool with operation "read", scope "project", name "build"
    Then the output contains "pnpm build"
    And the output includes the fact's frontmatter

  Scenario: read of an unknown slug returns a structured error
    When the agent calls the Memory tool with operation "read" and an unknown slug
    Then the tool returns isError true with reason "NOT_FOUND"
    And the message names the requested slug and scope
    And the message suggests calling operation "list" to see available slugs
```

## Files

- **Modify**: `packages/agent-core/src/tools/builtin/state/memory.ts` — add `view`, `list`, `read` operation handlers in `resolveExecution`.
- **Modify**: `packages/agent-core/src/memory/store.ts` — implement `FileMemoryStore.list` and `FileMemoryStore.read`.

## Implementation guidance

`FileMemoryStore.list(scope)`:

1. `readdir(rootFor(scope))`, filter `.md`, skip `MEMORY.md`, skip invalid slugs, `parseMemoryFile` each, drop malformed (with warning), return sorted by slug.

`FileMemoryStore.read(scope, slug)`:

1. Validate slug via `isValidSlug`; throw `INVALID_SLUG` otherwise.
2. Resolve path; ensure inside scope root (path-traversal guard).
3. If symlink, refuse (return `undefined` + warning, or throw `SYMLINK_REFUSED` — pick one consistent with how the tool surface marshalls it; the tool then returns `isError: true`).
4. `parseMemoryFile`, return `MemoryEntry` or `undefined`.

Memory tool handlers:

- `view` → call `loadMemory(kaos, workspace.workspaceDir)` and return its string as the tool output.
- `list` → call `store.list(scope)` for the requested scope (or both scopes when `scope` is omitted) → format as `## Project` / `## User` grouped markdown with `- <slug> (<type>) — <description>` rows. Apply optional `type` filter. Always full set (no budget cap on list output).
- `read` → call `store.read(scope, slug)`; on `undefined`, return `{ isError: true, output: 'NOT_FOUND: ... call operation "list" to ...' }`.

## Verification

- `pnpm test packages/agent-core/test/tools/memory.test.ts` — write + read cases all pass.
- `pnpm typecheck` + `pnpm lint` pass.
