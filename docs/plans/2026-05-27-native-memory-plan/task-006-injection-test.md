# Task 006 test — System-prompt injection

**Subject**: BDD-driven tests for `KIMI_MEMORY` template var, section placement, empty omission, source-path annotations, byte budget.
**Type**: test
**Depends-on**: ["001"]

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

- **Extend** `packages/agent-core/test/profile/context.test.ts` — add a `describe('system prompt: KIMI_MEMORY', ...)` block that renders the full system prompt via the profile resolver and asserts on the rendered string.

## Implementation guidance

- Build a `SystemPromptContext` with `memoryIndex` populated; resolve the default profile; assert the rendered prompt contains `# Memory` between `# Project Information` and `# Skills`.
- Empty `memoryIndex` → no `# Memory` section.
- Source-path annotations: assert the rendered index includes `## Project (.../memory)` and `## User (~/.kimi-code/memory)` literal substrings.
- Byte budget: build entries totaling > 8 KB; assert truncation order (User reverse-alpha first, then Project reverse-alpha) and sentinel presence.

## Verification

- `pnpm test packages/agent-core/test/profile/context.test.ts` — new injection cases FAIL initially (no `KIMI_MEMORY` rendering yet).
- After 006-impl: all pass.
