# Task 007 test — Survives /compact and session restart

**Subject**: Tests confirming memory survives `/compact` and session restart, plus subagent visibility timing.
**Type**: test
**Depends-on**: ["001"]

## BDD Scenarios

```gherkin
Feature: Survives /compact and session restart

  Scenario: Resuming a session re-reads memory from disk
    Given a previous session wrote fact "x" to project scope
    And the session metadata is persisted but the in-memory cache is empty
    When the session resumes and renders its first system prompt
    Then fact "x" appears in the rendered index
    And the index is read from disk, not restored from session state

  Scenario: /compact preserves memory injection on the next turn
    Given memory contains fact "y"
    When the user runs /compact
    And the agent starts the next turn
    Then fact "y" still appears in the assembled system prompt
    And no duplicate "# Memory" section is rendered

  Scenario: Subagent write becomes visible to parent on next turn
    Given the parent agent's current turn is mid-flight
    When a spawned subagent calls the Memory tool with operation "write" for slug "newfact"
    Then the parent's current system prompt does NOT yet contain "newfact"
    And the parent's next turn's system prompt DOES contain "newfact"
```

## Files

- **Extend** `packages/agent-core/test/profile/context.test.ts` — add a `describe('memory resilience', ...)` block covering re-read on resume.
- **Extend** an existing session test file (search for `session.test.ts` or `compaction.test.ts` under `packages/agent-core/test/`) for `/compact` and subagent visibility scenarios. Identify the nearest existing test file as the extension point during execution; if no suitable file exists, create `packages/agent-core/test/memory/resilience.test.ts`.

## Implementation guidance

- "Resume re-reads from disk": write a fact via `FileMemoryStore`; build a fresh `SystemPromptContext` (no shared state); assert the rendered prompt contains the slug.
- "/compact preserves": render system prompt before and after a simulated compact step; assert single `# Memory` section in both. The simulated compact triggers via the existing compaction test harness (extend the existing test file).
- "Subagent write visible on next turn": call `prepareSystemPromptContext` once → render → write a fact → render again → assert second render contains the slug, first did not.

## Verification

- `pnpm test packages/agent-core/test/profile/context.test.ts` — resilience cases pass after 007-impl.
- Compaction tests: run the affected file with `pnpm test <path>`.
