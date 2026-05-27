# Task 002 test — Storage with layered scopes (loader + index render)

**Subject**: BDD-driven tests for `loadMemory` and `renderIndex` covering scope merging, override, missing-dir, non-git, reserved filename, byte budget, subagent inheritance.
**Type**: test
**Depends-on**: ["001"]

## BDD Scenarios

```gherkin
Feature: Storage with layered scopes

  Background:
    Given a clean user home directory
    And a clean project working directory inside a git repository

  Scenario: Loading from user scope only
    Given the user scope contains a fact "code-style" of type "user"
    And the project scope contains no memory directory
    When the agent assembles the system prompt
    Then the rendered index lists "code-style" under the User section
    And the index is annotated with the user-scope source path
    And no Project section is rendered

  Scenario: Loading from project scope only
    Given the project scope contains a fact "build-commands" of type "project"
    And the user scope contains no memory directory
    When the agent assembles the system prompt
    Then the rendered index lists "build-commands" under the Project section
    And the index is annotated with the project-scope source path

  Scenario: Loading merged user and project indexes with no collisions
    Given the user scope contains a fact "code-style"
    And the project scope contains a fact "build-commands"
    When the agent assembles the system prompt
    Then both facts appear in the rendered index
    And the Project section appears before the User section

  Scenario: Project slug shadows user slug on collision
    Given the user scope contains a fact "code-style" with description "global default"
    And the project scope contains a fact "code-style" with description "repo-specific"
    When the agent assembles the system prompt
    Then exactly one entry for slug "code-style" is rendered in the index
    And that entry comes from the Project section
    And the user-scope fact remains addressable via the Memory tool with scope "user"

  Scenario: Subagent inherits parent's memory index
    Given the main agent has a memory index containing fact "test-runner"
    When the subagent host spawns a subagent with the same cwd
    Then the subagent's system prompt also contains the "test-runner" index entry
    And the subagent's index is loaded fresh from disk (not copied from parent state)

  Scenario: Missing memory directory is handled silently
    Given neither user nor project memory directories exist
    When the agent assembles the system prompt
    Then no Memory section is injected
    And no error or warning is recorded
    And no empty header is rendered

  Scenario: Non-git working directory falls back to no project scope
    Given the working directory is not inside a git repository
    And the user scope contains a fact "global-pref"
    When the agent assembles the system prompt
    Then only the user-scope index is loaded
    And no project-scope lookup is attempted

  Scenario: Reserved filename MEMORY.md is skipped during scan
    Given the project scope directory contains a file named "MEMORY.md"
    When the agent assembles the system prompt
    Then the file named "MEMORY.md" is not treated as a fact
    And no entry for slug "memory" is rendered from that file
```

## Files

- **Extend** `packages/agent-core/test/profile/context.test.ts` (per repo `AGENTS.md`: do not add many new test files; reuse the existing fs-fixture helpers there) — add a `describe('loadMemory', ...)` block.

## Implementation guidance (test scaffolding, NO production logic)

Use the `mkdtemp` + `vi.spyOn(localKaos, 'gethome')` pattern from the existing AGENTS.md tests. One test per scenario. Each test stages the fixture directories, calls `loadMemory(localKaos, workDir)`, and asserts:

- Section order (`## Project` before `## User`).
- Annotation comment present for each scope.
- Slug entries present/absent.
- Empty merged set → returned string is `""`.
- Reserved `MEMORY.md` file is skipped (no entry rendered for slug `memory`).
- Override: only Project entry rendered when both scopes hold the same slug; user-scope file still exists on disk afterwards.
- Non-git workdir: only user-scope readdir is invoked (assert via Kaos spy).

## Verification

- `pnpm test packages/agent-core/test/profile/context.test.ts` — all new `loadMemory` cases must FAIL initially (RED state). Tests are well-formed: they import from `#/memory/loader` and the module exists (created in 001) but the function body throws "not implemented" → tests fail with that message, not a compile/import error.
- After 002-impl: same command, all pass.
