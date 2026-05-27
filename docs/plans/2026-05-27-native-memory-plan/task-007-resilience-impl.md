# Task 007 impl — Resilience verification (and small hardening if needed)

**Subject**: Confirm the injection refresh path works correctly across resume / compact / subagent boundaries; add minimal hardening only if a test fails.
**Type**: impl
**Depends-on**: ["007-test", "006-impl", "003-impl"]

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

- **Likely no source changes**: the design predicts these scenarios pass for free because memory lives in the system prompt (rebuilt each turn), the loader reads from disk every time, and subagents call `prepareSystemPromptContext` independently. If 007-test fails, investigate which assumption broke and patch the minimal site.
- **Possible site of change**: `packages/agent-core/src/agent/compaction/full.ts` if `/compact` somehow caches the system prompt; `packages/agent-core/src/session/subagent-host.ts:286` if subagent context construction skips the loader.

## Implementation guidance

1. Run 007-test. If all pass → no source change needed; commit the test additions only (this impl is verification-only).
2. If any fail, identify the failing assumption with a tracer (e.g., spy on `loadMemory` to count invocations per turn) and patch the minimal call site to re-invoke `loadMemory` at the right boundary.
3. Do NOT add a new "memory refresh" hook — the design specifies system-prompt re-rendering as the mechanism. Any required fix should preserve that contract.

## Verification

- `pnpm test packages/agent-core/test/profile/context.test.ts` — resilience cases pass.
- Compaction + subagent test suites still pass.
- No new public APIs introduced.
