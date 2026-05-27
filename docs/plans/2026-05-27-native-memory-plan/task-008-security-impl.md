# Task 008 impl — Path-traversal + symlink refusal + plan-mode policy extension

**Subject**: Harden the Memory tool / store with path-safety checks and add a plan-mode write block.
**Type**: impl
**Depends-on**: ["008-test", "003-impl"]

## BDD Scenarios

```gherkin
Feature: Security and path safety

  Scenario: Memory write outside the memory directory is rejected
    When the agent calls the Memory tool with operation "write" and a slug containing "../escape"
    Then the tool returns isError true with reason matching "PATH_OUTSIDE_WORKSPACE" or "INVALID_SLUG"
    And no file is created
    And no I/O is performed outside the memory directory

  Scenario: Slug validation rejects unsafe characters
    When the agent calls the Memory tool with operation "write" and slug "FOO BAR/.."
    Then the tool returns isError true with reason "INVALID_SLUG"
    And the message names the allowed slug pattern
    And no file is created

  Scenario: Slug validation rejects leading or trailing hyphens
    When the agent calls the Memory tool with operation "write" and slug "-leading"
    Then the tool returns isError true with reason "INVALID_SLUG"
    And no file is created

  Scenario: Symlink inside the memory directory is not followed
    Given a symlink "trap.md" inside the project memory directory pointing to "/etc/passwd"
    When the agent calls the Memory tool with operation "read" and slug "trap"
    Then the tool returns isError true with a symlink-refusal reason
    And "/etc/passwd" is not read

  Scenario: Plan mode blocks Memory writes
    Given plan mode is active
    When the agent calls the Memory tool with operation "write", "update", or "delete"
    Then the tool returns isError true
    And the message instructs the agent to call ExitPlanMode first
    And read-only operations ("view", "list", "read") still succeed
```

## Files

- **Modify**: `packages/agent-core/src/memory/slug.ts` — finalize the `SLUG_PATTERN` regex and `isValidSlug` body (if not yet complete from 003-impl).
- **Modify**: `packages/agent-core/src/memory/store.ts` — reuse `canonicalizePath` + `isWithinDirectory` from `packages/agent-core/src/tools/policies/path-access.ts` for every path resolution; refuse symlinks (`stat`-check, do not follow).
- **Modify**: `packages/agent-core/src/agent/permission/policies/plan.ts:80-118` — extend `PlanModeGuardPermissionPolicy` to match the `memory` tool when `operation ∈ {write, update, delete}` and return `{ block: true, reason: 'Plan mode is active. Call ExitPlanMode first.' }`. Read ops pass through.

## Implementation guidance

Slug:
```ts
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export function isValidSlug(slug: string): boolean { return SLUG_PATTERN.test(slug); }
```

Store path-traversal guard:
- Every path-building operation in the store goes through:
  ```ts
  const finalPath = join(rootFor(scope), slug + '.md');
  if (!isWithinDirectory(rootFor(scope), finalPath)) throw new PathSecurityError(...);
  ```

Symlink refusal:
- Before any read/write of a `<slug>.md` file: `const s = await kaos.stat(path)`. If `s.isSymlink()` (or the kaos equivalent — check the existing API for symlink detection; if missing, follow the design's "lexical, no follow" approach with a `lstat`-style check), throw `SYMLINK_REFUSED`.

Plan-mode policy:
- Mirror the existing `Write`/`Edit` matching block. Add a clause that matches `tool.name === 'memory'` and `input.operation ∈ {write, update, delete}`; return `{ kind: 'result', result: { block: true, reason: 'Plan mode is active. Call ExitPlanMode first.' } }`.

## Verification

- `pnpm test packages/agent-core/test/tools/memory.test.ts` — security cases pass.
- Existing plan-policy tests still pass (no regression to `Write`/`Edit` matching).
- `pnpm typecheck` + `pnpm lint` pass.
