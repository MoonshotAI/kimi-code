# Task 005 impl — Memory tool update/delete + FileMemoryStore.update/delete

**Subject**: Implement `update` and `delete` operations on the Memory tool and store with atomic write semantics.
**Type**: impl
**Depends-on**: ["005-test"]

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

- **Modify**: `packages/agent-core/src/tools/builtin/state/memory.ts` — add `update` and `delete` handlers.
- **Modify**: `packages/agent-core/src/memory/store.ts` — implement `FileMemoryStore.update` and `FileMemoryStore.delete`.

## Implementation guidance

`FileMemoryStore.update(scope, slug, patch)`:

1. Validate slug.
2. Read existing entry; if missing → `NOT_FOUND` error.
3. Merge: `nextRecord = { ...existing.record, ...patch.record }` (partial frontmatter merge); `nextBody = patch.body ?? existing.body`.
4. Validate body length ≤ 4 KB.
5. Atomic tmp-rename onto the same final path (overwrite).
6. Return updated entry.

`FileMemoryStore.delete(scope, slug)`:

1. Validate slug.
2. Resolve path; ensure inside scope root.
3. `kaos.rm(path)`. Missing file → return `false` (idempotent). Errors → propagate.
4. Return `true` on successful removal.

Memory tool handlers:

- `update` → `store.update(scope, name, { record, body })`. On `NOT_FOUND` → return `isError: true`.
- `delete` → `store.delete(scope, name)`. On `false` (missing file) → return `isError: true` with `NOT_FOUND` (per design — surface to agent for clarity).

## Verification

- `pnpm test packages/agent-core/test/tools/memory.test.ts` — all Memory tool cases pass (write + read + update + delete = 17 scenarios across Features 2/3/4).
- `pnpm typecheck` + `pnpm lint` pass.
