# Task 003 test — Agent writes via the Memory tool

**Subject**: BDD-driven tests for the Memory tool `write` operation (atomic write, duplicate slug, body cap, missing frontmatter, secret warning).
**Type**: test
**Depends-on**: ["001"]

## BDD Scenarios

```gherkin
Feature: Agent writes via the Memory tool

  Background:
    Given the agent has the Memory tool enabled
    And the agent is running inside a git repository

  Scenario: Agent creates a new fact
    When the agent calls the Memory tool with operation "write", scope "project", name "preferred-test-runner", description "Use vitest, never jest.", type "project", body "Use vitest, never jest."
    Then a body file is created at "<project-root>/.kimi-code/memory/preferred-test-runner.md"
    And the file's frontmatter matches the supplied record
    And the tool result confirms the scope and slug

  Scenario: Atomic write — body is created via tmp-rename
    When the agent calls the Memory tool with operation "write"
    Then the body file appears via a tmp-rename sequence (no partial state visible on interrupt)
    And no `.tmp-*` file remains after completion

  Scenario: Duplicate slug is rejected with a helpful error
    Given the project scope already contains slug "code-style"
    When the agent calls the Memory tool with operation "write" for the same slug in the same scope
    Then the tool returns isError true with reason "EXISTS"
    And the error message suggests operation "update"
    And the existing file is not modified

  Scenario: Body exceeding 4 KB is rejected with a size hint
    When the agent calls the Memory tool with operation "write" and a body of 4097 bytes
    Then the tool returns isError true with reason "BODY_TOO_LARGE"
    And the message states the 4 KB body limit
    And no file is created

  Scenario: Frontmatter missing required fields is rejected
    When the agent calls the Memory tool with operation "write" and omits the type field
    Then the tool returns isError true
    And the error lists the missing field "type"
    And the accepted enum values are listed: user, feedback, project, reference

  Scenario: Secret-looking content triggers a warning but does not block
    When the agent calls the Memory tool with operation "write" and a body containing "sk-ant-xxxxxxxxxxxxxxxxxxxx"
    Then the fact is written successfully
    And the tool result includes a warning naming the matched pattern category
    And the wire log records the warning (pattern category only; no raw match)
```

## Files

- **Create**: `packages/agent-core/test/tools/memory.test.ts` — new file (no sibling test file covers the Memory tool surface). Use the same `mkdtemp` + `vi.spyOn(localKaos, 'gethome')` pattern as `context.test.ts`.

## Implementation guidance

Each scenario maps to one `it()`. Test the tool by:

1. Constructing a `MemoryTool` instance with a stubbed `Kaos` pointing at a tmp dir.
2. Calling `tool.resolveExecution({ operation: 'write', ... }).execute()`.
3. Asserting result shape, files on disk, error reasons.

For "atomic write — tmp-rename":
- Inject a Kaos stub that captures call order. Assert: `writeText(*.tmp-*)` precedes `rename(*.tmp-* → final)`.
- For the failure-mid-write case (cover via separate test if needed in 008-test instead): inject a stub that throws on `rename`. Assert: final file does not exist; tmp file may or may not be cleaned (tolerant).

For "duplicate slug":
- Pre-create a body file at the target path.
- Call `write` → assert `isError: true`, `reason: 'EXISTS'`, message mentions `update`.

For "body too large":
- Pass a 4097-byte string. Assert: rejection before any I/O (no file created).

For "missing required field":
- Drop `type` from input. Assert: zod-style schema rejection with enum values enumerated in message.

For "secret warning":
- Body contains a recognizable secret pattern. Assert: write succeeds, result `output` includes a warning, the warning names the pattern *category* (not the raw match).

## Verification

- `pnpm test packages/agent-core/test/tools/memory.test.ts` — all 6 cases FAIL initially (RED). The tests compile (`MemoryTool` class shell exists from 001) but the execution path throws "not implemented".
- After 003-impl: all 6 cases pass.
