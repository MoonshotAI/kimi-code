# Task 004 test — Agent reads via the Memory tool

**Subject**: BDD-driven tests for `view`, `list`, `read` operations.
**Type**: test
**Depends-on**: ["001"]

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

- **Extend** `packages/agent-core/test/tools/memory.test.ts` (same file created in 003-test) — add a `describe('read operations', ...)` block.

## Implementation guidance

Pre-populate the tmp memory dirs with body files via `FileMemoryStore.write` (now implemented after 003-impl). Each scenario asserts:

- `view` returns the same string `loadMemory` returns (re-uses the renderer).
- `list` returns a markdown grouped list; filter args reduce the set.
- `list` always returns untruncated (use the raw entries from the store, not the rendered index).
- `read` returns frontmatter + body as a markdown string.
- `NOT_FOUND` error mentions slug, scope, and suggests `list`.

For the "200 facts truncated" scenario: write 200 facts with short descriptions that together exceed 8 KB; assert `view` truncates with the sentinel; `list scope="project"` returns the full 200.

## Verification

- `pnpm test packages/agent-core/test/tools/memory.test.ts` — read cases FAIL initially.
- After 004-impl: all pass.
