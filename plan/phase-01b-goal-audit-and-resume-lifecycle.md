# Phase 1b: Goal Audit And Resume Lifecycle

## Goal

Add audit records and resume behavior for the goal state from Phase 1a.

This phase is complete when goal lifecycle, budget, evaluator, continuation, and clear events are written to `agents/main/wire.jsonl`, replay ignores those records as state input, and resume preserves or removes goal state by explicit rules.

## Background

Replay audit data lives in `AgentRecords`.
`FileSystemAgentRecordPersistence` writes each agent's `wire.jsonl`.
There is one `wire.jsonl` per agent.

`SessionGoalStore` is owned by `Session`.
`AgentRecords` is owned by `Agent`.
The store therefore needs a lazy way to reach the main agent record sink.

## Reason

`state.json` is the source of truth for the current goal.
`agents/main/wire.jsonl` is the audit trail.

The continuation loop and evaluator need evidence that survives export and debugging.
Replay must not rebuild goal state from `goal.*` records, because that would make resume depend on historical evidence instead of `state.json`.

## Concrete Changes

Modify `packages/agent-core/src/session/goal.ts`.
Extend `SessionGoalStore` with:

- a lazy main-agent audit sink
- a pending audit queue
- `flushPendingRecords()`
- `normalizeMetadata()`

`SessionGoalStore` shall:

- check the lazy main-agent audit sink before each audit write
- write directly when the sink is available
- queue audit records when the sink is unavailable
- flush queued records in original order when `flushPendingRecords()` runs

Use this method-to-record mapping:

- `createGoal()` appends `goal.create`
- `createGoal({ replace: true })` appends `goal.clear` for the previous goal before the new `goal.create`
- `createGoal()` over a terminal goal appends `goal.clear` for the previous goal before the new `goal.create`
- `pauseGoal()` appends `goal.update`
- `resumeGoal()` appends `goal.update`
- `updateGoal()` appends `goal.update`
- `recordTokenUsage()` appends `goal.account_usage`
- `recordWallClockUsage()` appends `goal.account_usage`
- `incrementTurn()` appends `goal.continuation`
- `recordModelReport()` appends `goal.report`
- `recordEvaluatorVerdict()` appends `goal.evaluate`
- `markBudgetLimited()` appends `goal.update`
- `markInterrupted()` appends `goal.update`
- `markError()` appends `goal.update`
- `cancelGoal()` appends `goal.update` with `status: 'cancelled'`, then `goal.clear`
- `clearGoal()` appends `goal.clear`

`goal.account_usage` records shall include whether the delta came from token accounting or wall-clock accounting.
Token accounting may come from any session agent.
Evaluator token accounting shall use source `goal_evaluator`.
Wall-clock accounting shall be main-agent-only in Phase 4b.

Modify `packages/agent-core/src/session/index.ts`.
Create `SessionGoalStore` with a lazy audit sink:

```ts
() => this.agents.get('main')?.records
```

`Session.createMain()` and `Session.resume()` shall call `goals.flushPendingRecords()` after the main agent exists.
`Session.resume()` shall call `goals.normalizeMetadata()` after `readMetadata()`.

`normalizeMetadata()` shall:

- convert a valid `active` goal to `paused` on resume, with a reason such as `Paused after session resume`
- append `goal.update` for the resume-time active-to-paused transition after the main-agent audit sink is available
- leave valid `paused` and terminal goals intact
- remove malformed goal data
- remove stale `cancelled` goals that were persisted before clear completed
- preserve unrelated `metadata.custom` keys

An `active` goal cannot be assumed to still be running after process restart because continuation only runs inside an active `TurnFlow` turn.
Restoring it as `paused` makes the status match runtime reality and requires `/goal resume` to restart work.

Terminal statuses such as `complete`, `blocked`, `impossible`, `budget_limited`, `interrupted`, and `error` shall survive resume.
This lets `/goal` show the final status until the user clears or replaces it.

Modify `packages/agent-core/src/agent/records/types.ts`.
Add:

- `goal.create`
- `goal.update`
- `goal.account_usage`
- `goal.continuation`
- `goal.report`
- `goal.evaluate`
- `goal.clear`

Modify `packages/agent-core/src/agent/records/index.ts`.
Replay shall ignore `goal.*` records.
Active or terminal goal state shall come from `state.json`.

## Tests

Extend `packages/agent-core/test/session/goal.test.ts`.

The tests shall cover:

- pending audit records flush to the main-agent record sink once it becomes available
- queued `goal.create` records flush before later `goal.*` records
- replacing a goal appends one `goal.clear` for the old goal before the new `goal.create`
- `pauseGoal()` and `resumeGoal()` append `goal.update`
- `updateGoal()` appends terminal `goal.update`
- `recordTokenUsage()` and `recordWallClockUsage()` append `goal.account_usage`
- `incrementTurn()` appends `goal.continuation`
- `recordModelReport()` appends `goal.report`
- `recordEvaluatorVerdict()` appends `goal.evaluate`
- `cancelGoal()` appends `goal.update` before `goal.clear`
- `clearGoal()` appends `goal.clear`
- direct audit writes happen when the sink is already available
- `flushPendingRecords()` is idempotent
- `normalizeMetadata()` converts active goals to paused on resume
- `normalizeMetadata()` queues or writes a `goal.update` record for the active-to-paused resume transition
- `normalizeMetadata()` keeps paused goals on resume
- `normalizeMetadata()` keeps terminal goal snapshots on resume
- `normalizeMetadata()` removes malformed and stale cancelled goals on resume

These tests prove the bridge between session-owned state and main-agent audit records without needing a model turn.

Update `packages/agent-core/test/agent/records/index.test.ts` or add cases to the nearest existing records test.
The tests shall show that replaying `goal.*` records leaves agent-visible state unchanged.

Add or extend a session resume test.
It shall write `state.json` with an active goal, resume the session, and prove `Session.goals.getGoal()` returns the same goal with status `paused`.
It shall also write a terminal goal, resume the session, and prove `Session.goals.getGoal()` still returns the terminal snapshot.

## Verification

Run:

```bash
pnpm --filter @moonshot-ai/agent-core test -- test/session/goal.test.ts test/agent/records/index.test.ts
pnpm --filter @moonshot-ai/agent-core run typecheck
```

This phase should not add `/goal`, model tools, injection, accounting, continuation, or evaluator code.
