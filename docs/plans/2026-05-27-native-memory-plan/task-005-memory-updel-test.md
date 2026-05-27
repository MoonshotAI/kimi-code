# Task 005 test — Agent updates and deletes via the Memory tool

**Subject**: BDD-driven tests for `update` and `delete` operations.
**Type**: test
**Depends-on**: ["001"]

## BDD Scenarios

```gherkin
Feature: Agent updates and deletes via the Memory tool

  Scenario: update replaces body
    Given a fact "build" exists with body "old"
    When the agent calls the Memory tool with operation "update", scope "project", name "build", body "new"
    Then the body file now contains "new"
    And the rendered index reflects any frontmatter changes
    And the write is atomic (tmp-rename)

  Scenario: update merges partial frontmatter
    Given a fact "build" exists with description "Use pnpm" and type "project"
    When the agent calls the Memory tool with operation "update", scope "project", name "build", record.description "Use pnpm exclusively"
    Then the body is preserved
    And the frontmatter description updates to "Use pnpm exclusively"
    And the frontmatter type remains "project"

  Scenario: update of an unknown slug fails without creating a file
    When the agent calls the Memory tool with operation "update" and an unknown slug
    Then the tool returns isError true with reason "NOT_FOUND"
    And no new body file is created

  Scenario: delete removes the body file
    Given a fact "obsolete" exists
    When the agent calls the Memory tool with operation "delete" and slug "obsolete"
    Then the body file no longer exists
    And the next rendered index omits the slug

  Scenario: deleting the last fact in a scope leaves an empty scope dir
    Given the project scope contains exactly one fact
    When the agent calls the Memory tool with operation "delete" on that slug
    Then the scope directory still exists
    And the next rendered index omits the Project section entirely
    And the system prompt's Memory section is omitted if the User scope is also empty
```

## Files

- **Extend** `packages/agent-core/test/tools/memory.test.ts` — add a `describe('update and delete operations', ...)` block.

## Implementation guidance

Pre-populate with `FileMemoryStore.write`. For `update`:

- Body-only patch: assert body changes, frontmatter unchanged.
- Frontmatter-only patch (`record.description`): assert frontmatter merges (other fields preserved), body unchanged.
- Atomic-write: capture Kaos calls; assert tmp-rename sequence.
- Unknown slug: assert `isError: true`, `NOT_FOUND`, no new file.

For `delete`:

- Existing slug: assert file gone; re-call `loadMemory` and assert slug not in rendered index.
- Last-fact-in-scope: write then delete; assert dir still exists but the next rendered index has no Project section; if user scope also empty, the entire rendered string is `""`.

## Verification

- `pnpm test packages/agent-core/test/tools/memory.test.ts` — update/delete cases FAIL initially.
- After 005-impl: all pass.
