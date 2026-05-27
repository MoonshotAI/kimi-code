# Task 010 impl — Emit telemetry events

**Subject**: Emit `memory_write`, `memory_update`, `memory_delete`, `memory_index_truncated` events.
**Type**: impl
**Depends-on**: ["010-test", "002-impl", "003-impl", "005-impl"]

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

- **Modify**: `packages/agent-core/src/tools/builtin/state/memory.ts` — emit events on each successful mutation. Payload: `{ scope, slug }`. No body content in payload.
- **Modify**: `packages/agent-core/src/memory/loader.ts` (or `renderIndex` site) — when entries are dropped due to budget, emit `memory_index_truncated` with `{ droppedCount: number }`.

## Implementation guidance

- Identify the project's `track(event, payload)` pattern by reading `kimi-tui.ts:5612` (`this.track('init_complete')`) and tracing the import. Use the same surface from the agent-core side.
- Telemetry calls fire-and-forget. Do not let a telemetry failure fail the tool operation.

## Verification

- All telemetry tests pass.
- Other Memory tool tests still pass (no regression from event-emission injection).
- `pnpm typecheck` + `pnpm lint` pass.
