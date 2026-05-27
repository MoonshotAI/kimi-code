# Task 008 test — Security and path safety

**Subject**: BDD-driven tests for path traversal, slug validation, symlink refusal, plan-mode block.
**Type**: test
**Depends-on**: ["001"]

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

- **Extend** `packages/agent-core/test/tools/memory.test.ts` — add a `describe('security', ...)` block for slug/path/symlink scenarios.
- **Extend** the existing plan-mode permission-policy test file (under `packages/agent-core/test/agent/permission/` — locate at execution time) for the plan-mode block scenario. If no suitable file exists, add to `memory.test.ts`.

## Implementation guidance

- Slug variants: pass `"../escape"`, `"FOO BAR/.."`, `"-leading"`, `"trailing-"`, uppercase `"BadSlug"`, empty `""`. Assert all rejected pre-I/O (use a Kaos spy that fails the test if `writeText` is called).
- Symlink: create a real symlink in the tmp dir pointing to `/etc/passwd` (or a sentinel file); call `read`; assert `isError: true` and that the sentinel is never read.
- Plan mode: drive the existing `PlanModeGuardPermissionPolicy` test infra. Set `agent.planMode.isActive = true`. Call Memory tool with each op. Write/update/delete → blocked. View/list/read → allowed.

## Verification

- `pnpm test packages/agent-core/test/tools/memory.test.ts` — all 5 security cases FAIL initially.
- After 008-impl: all pass.
