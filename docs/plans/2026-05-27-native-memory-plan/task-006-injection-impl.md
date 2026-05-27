# Task 006 impl — SystemPromptContext extension + buildTemplateVars + system.md template

**Subject**: Wire the rendered memory index into the system prompt.
**Type**: impl
**Depends-on**: ["006-test", "002-impl"]

## BDD Scenarios

```gherkin
Feature: System-prompt injection

  Scenario: Index renders into a dedicated section of the system prompt
    Given the user scope and project scope both contain at least one fact
    When the system prompt is rendered
    Then a "# Memory" section appears in the rendered prompt
    And the section contains the merged index
    And the section sits between "# Project Information" and "# Skills"

  Scenario: Each scope block is annotated with its source path
    When the system prompt is rendered with both scopes populated
    Then the Project block heading mentions the project memory directory path
    And the User block heading mentions "~/.kimi-code/memory"

  Scenario: Empty merged set omits the Memory section entirely
    Given no facts exist in any scope
    When the system prompt is rendered
    Then the rendered prompt contains no "# Memory" header
    And no Memory annotation comments are emitted

  Scenario: Total index byte budget is enforced
    Given the merged index would exceed 8 KB rendered
    When the system prompt is rendered
    Then User entries are dropped first (reverse-alpha) until under budget
    And then Project entries are dropped (reverse-alpha) if still over budget
    And the truncated section ends with a sentinel comment "<!-- truncated: N entries omitted; call Memory.list for the full set -->"
    And dropped slugs are not silently lost — they remain on disk and visible via operation "list"
```

## Files

- **Modify**: `packages/agent-core/src/profile/types.ts:36` — add `readonly memoryIndex?: string` to `SystemPromptContext`.
- **Modify**: `packages/agent-core/src/profile/context.ts:12-36` — extend `PreparedSystemPromptContext.Pick`; in `prepareSystemPromptContext` add `loadMemory(kaos, resolvedCwd)` to the `Promise.all` and return `memoryIndex`.
- **Modify**: `packages/agent-core/src/profile/resolve.ts` (`buildTemplateVars`) — add `KIMI_MEMORY: context.memoryIndex ?? ''`.
- **Modify**: `packages/agent-core/src/profile/default/system.md` — insert `# Memory` section under `{% if KIMI_MEMORY %}` immediately after `# Project Information` (after line 128), before `# Skills` (line 130). Section body per design `architecture.md` §9.

## Verification

- `pnpm test packages/agent-core/test/profile/context.test.ts` — all 4 injection cases pass.
- `pnpm test packages/agent-core/test/profile` — existing AGENTS.md tests still pass (no regression).
- `pnpm typecheck` + `pnpm lint` pass.
