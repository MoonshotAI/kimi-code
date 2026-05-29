# Phase 4b: Goal Usage Accounting

## Goal

Update goal usage counters from real agent work.

This phase is complete when token usage counts all session agents that run under an active goal, and the goal store exposes wall-clock accounting that Phase 4c can advance before each budget check.

## Background

`TurnFlow` runs for every `Agent`.
`packages/agent-core/src/agent/turn/index.ts` calls `runTurn()` from `packages/agent-core/src/loop/run-turn.ts`.
`runTurn()` executes one or more model steps and calls `afterStep` after each sealed step.

`executeLoopStep()` in `packages/agent-core/src/loop/turn-step.ts` records provider usage before `afterStep`.
That gives goal accounting a stable per-step usage delta.

Subagents can consume a large share of tokens.
The earlier plan counted only main-agent tokens, which would understate goal cost.
Wall-clock time is different because concurrent subagents can double-count elapsed time.
It also cannot be recorded only in `turnWorker()` cleanup once Phase 4c exists, because one continued goal run stays inside a single `runTurn()` until the loop stops.

## Reason

Budget enforcement needs runtime-owned counters.
The model should read budget state, not invent it.

Token budget shall mean session token budget for goal work.
Wall-clock budget shall mean elapsed main-agent goal time.
This counts cost without double-counting parallel elapsed time.

Terminal goal cleanup is not part of this phase.
Terminal snapshots shall remain in `state.json` until the user clears or replaces them, so `/goal` can show final status.

## Concrete Changes

Modify `packages/agent-core/src/agent/turn/index.ts`.
In the `afterStep` hook passed to `runTurn()`, after `this.agent.usage.record(model, usage, 'turn')`, call goal token accounting when an active goal exists:

- use `grandTotal(usage)` from `packages/kosong/src/usage.ts`
- call `this.agent.goals?.recordTokenUsage({ tokenDelta, agentId, agentType, source: 'agent_step' })`
- include tokens from main agents and subagents
- skip accounting when there is no active goal

Add a short code comment before goal token accounting:

```ts
// Goal token budgets count every session agent step.
```

Do not record main-agent wall-clock usage from `turnWorker()` cleanup as the primary budget mechanism.
Phase 4c will advance wall-clock usage incrementally from `GoalContinuationController` before each continuation budget check.
This keeps `--max-minutes` enforceable during a long continued turn.

`turnWorker()` cleanup may record one final wall-clock delta only through a Phase 4c finalization hook, so aborted or failed turns do not lose the last interval.
That finalization must not be the only wall-clock accounting path.

Do not call any goal clear method from turn cleanup.
Terminal goal state remains available for `/goal` status.

Modify `packages/agent-core/src/session/goal.ts`.
Ensure `recordTokenUsage()`:

- updates `tokensUsed`
- writes `state.json`
- appends one `goal.account_usage` record with the agent id and agent type
- records `source: 'agent_step'`
- updates token budget flags
- leaves `status` unchanged

Ensure `recordWallClockUsage()`:

- accumulates `wallClockMs`
- writes `state.json`
- appends one `goal.account_usage` record
- updates wall-clock budget flags
- leaves `status` unchanged

Budget flags shall become visible through `getGoal()` and `GetGoalTool`.
Phase 4c decides what to do when a hard budget is reached.

## Tests

Add tests to `packages/agent-core/test/agent/turn.test.ts` or a focused goal accounting test.

The tests shall simulate turns with known `TokenUsage`.
They shall prove:

- a main-agent step adds `grandTotal(usage)` to `tokensUsed`
- a subagent step also adds `grandTotal(usage)` to `tokensUsed`
- token usage is recorded per sealed model step
- no counters change when no active goal exists
- no `goal.account_usage` record is appended when no active goal exists
- token budget flags update without changing `status`
- wall-clock usage can be recorded incrementally for the main agent
- subagent wall-clock time does not update `wallClockMs`
- a superseded main-agent turn where `this.currentId !== turnId` does not update final wall-clock counters
- paused and terminal goals do not receive usage
- terminal goals are not cleared by turn cleanup

These tests bind token accounting to the same hooks used by real turns and prove the store-side wall-clock API that Phase 4c needs for live budget checks.

## Verification

Run:

```bash
pnpm --filter @moonshot-ai/agent-core test -- test/agent/turn.test.ts
pnpm --filter @moonshot-ai/agent-core run typecheck
```

This phase should keep budget state current.
It should not auto-continue, evaluate completion, or clear terminal goals.
