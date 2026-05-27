# Task 010 test — Telemetry events

**Subject**: Tests for `memory_write` / `memory_update` / `memory_delete` / `memory_index_truncated` telemetry events.
**Type**: test
**Depends-on**: ["001"]

## BDD Scenarios

```gherkin
Feature: Telemetry

  Scenario: Each mutation emits a telemetry event
    When the agent successfully completes operation "write", "update", or "delete"
    Then a corresponding telemetry event is recorded (e.g. `memory_write`, `memory_update`, `memory_delete`)
    And the event includes scope and slug (no body content)

  Scenario: Index truncation increments a counter
    Given the rendered index overflows the 8 KB budget
    When the system prompt is assembled
    Then a `memory_index_truncated` event is recorded with the count of dropped entries
```

## Files

- **Extend** `packages/agent-core/test/tools/memory.test.ts` — add a `describe('telemetry', ...)` block. Spy on the telemetry surface (locate the project's telemetry test pattern by reading an existing test that uses `track(...)`).
- **Extend** `packages/agent-core/test/profile/context.test.ts` for the truncation-counter test (the renderer fires it during system-prompt assembly).

## Implementation guidance

- Spy on the existing telemetry sink (likely `track(event, payload)` somewhere in `packages/agent-core/src/agent` or `packages/telemetry`). Identify the precise hook at execution time.
- Assert each successful `write` / `update` / `delete` produces the corresponding event with `{ scope, slug }` payload — and explicitly assert the payload does **not** contain `body`.
- Assert truncation produces `memory_index_truncated` with `{ droppedCount: N }`.

## Verification

- New telemetry assertions FAIL initially.
- After 010-impl: all pass.
