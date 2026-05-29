# Phase 1a: Core Session Goal State

## Goal

Add durable goal-mode state to `packages/agent-core`.

This phase is complete when `Session` owns one current goal through `SessionGoalStore`, stores it in `Session.metadata.custom.goal`, and can represent active, paused, terminal, budget, and evidence data without any slash-command or model-tool code.

## Background

`Session.metadata` lives in `packages/agent-core/src/session/index.ts`.
It is written to `state.json` through `Session.writeMetadata()`.
Tests that inspect disk need to call `Session.flushMetadata()`.

`SessionAPIImpl.updateSessionMetadata()` in `packages/agent-core/src/session/rpc.ts` can update `metadata.custom`.
Goal state reserves `metadata.custom.goal`, so generic metadata updates must not replace it.

`Agent` can be constructed without a `Session`.
`Agent.goals` shall stay optional.
Agents created by `Session.instantiateAgent()` shall receive the session goal store.

## Reason

The earlier plan only tracked a goal.
It did not contain enough state for autonomous goal mode.

The continuation loop, evaluator, pause/resume, hard budgets, and user status command all need one durable state owner.
`Session.metadata.custom.goal` fits the existing session durability model and avoids adding a new database.

## Concrete Changes

Create `packages/agent-core/src/session/goal.ts`.
It shall define:

- `GoalStatus`
- `GoalBudgetLimits`
- `GoalEvidence`
- `SessionGoalState`
- `GoalSnapshot`
- `GoalToolResult`
- `SessionGoalStore`

Use this status model:

- `active`
- `paused`
- `complete`
- `blocked`
- `impossible`
- `budget_limited`
- `interrupted`
- `error`
- `cancelled`

`cleared` shall be an audit action, not a durable status.
When a goal is cleared, `metadata.custom.goal` is removed and `getGoal()` returns `{ goal: null }`.

`SessionGoalState` shall store:

- `goalId`
- `objective`
- `completionCriterion?: string`
- `status`
- `createdAt`
- `updatedAt`
- `startedBy`
- `updatedBy`
- `turnsUsed`
- `consecutiveNoProgressTurns`
- `consecutiveFailureTurns`
- `tokensUsed`
- `wallClockMs`
- `budgetLimits`
- `lastEvaluatorVerdict?: string`
- `lastEvaluatorReason?: string`
- `lastEvidence?: readonly GoalEvidence[]`
- `terminalReason?: string`
- `terminalEvidence?: readonly GoalEvidence[]`

`GoalBudgetLimits` shall support:

- `tokenBudget?: number`
- `turnBudget?: number`
- `wallClockBudgetMs?: number`
- `noProgressTurnLimit?: number`
- `failureTurnLimit?: number`

`SessionGoalStore.createGoal()` shall fill a conservative default `turnBudget` when none is provided.
Use a named constant, for example `DEFAULT_GOAL_TURN_BUDGET = 20`.
Token and wall-clock budgets may remain absent unless the caller provides them.

`SessionGoalStore` shall expose these methods:

- `createGoal({ objective, completionCriterion, budgetLimits, replace })`
- `getGoal()`
- `getActiveGoal()`
- `pauseGoal({ actor, reason })`
- `resumeGoal({ actor, reason })`
- `updateGoal({ status, actor, reason, evidence })`
- `recordTokenUsage({ tokenDelta, agentId, agentType, source })`
- `recordWallClockUsage({ wallClockMs })`
- `incrementTurn({ evidence })`
- `recordModelReport({ requestedStatus, reason, evidence })`
- `recordEvaluatorVerdict({ verdict, reason, evidence })`
- `markBudgetLimited({ reason, evidence })`
- `markInterrupted({ reason })`
- `markError({ reason })`
- `cancelGoal({ actor, reason })`
- `clearGoal({ actor, reason })`

`SessionGoalStore` shall:

- read and write `Session.metadata.custom.goal`
- reject empty objectives
- reject objectives longer than 4000 characters
- reject a second `active` or `paused` goal unless `replace: true`
- allow a new goal to replace a terminal goal
- clear the previous goal through the same internal clear path before storing a replacement
- return `{ goal: null }` when no current goal exists
- return only `active` from `getActiveGoal()`
- compute `remainingTokens: null` when no token budget is set
- compute numeric `remainingTokens` when a token budget is set
- compute `overBudget: true` when any hard budget has been reached or exceeded
- expose individual budget flags, such as `tokenBudgetReached`, `turnBudgetReached`, and `wallClockBudgetReached`
- preserve terminal goals until `clearGoal()` or replacement
- write metadata through `Session.writeMetadata()`

`updateGoal()` shall allow evaluator or continuation-controller terminal statuses only for:

- `complete`
- `blocked`
- `impossible`

Runtime code shall own:

- `budget_limited`
- `interrupted`
- `error`

`recordModelReport()` shall be the only model-facing terminal-report path.
It shall not change `status`.
It shall store the model's requested terminal state as evidence for the continuation controller.
Phase 4c may accept that self-report.
Phase 4d may require the independent evaluator to confirm it.

User code shall own:

- `paused`
- `cancelled`
- `cleared`

`cancelGoal({ actor: 'user' })` shall mark an active or paused goal `cancelled`, return the final snapshot, write audit data in Phase 1b, and clear `metadata.custom.goal`.

`clearGoal({ actor: 'user' })` shall remove any current goal.
It shall be idempotent.

Terminal snapshots shall not auto-expire in the initial implementation.
Phase 6 re-evaluates whether indefinite retention is still wanted after real sessions exist.

Modify `packages/agent-core/src/session/index.ts`.
`Session` shall own `readonly goals: SessionGoalStore`.
The constructor shall create it with:

- a metadata reader
- a metadata writer
- access to `Session.options.id`

`Session.instantiateAgent()` shall pass the goal store to every agent it creates.

Modify `packages/agent-core/src/agent/index.ts`.
`AgentOptions` shall accept `goals?: SessionGoalStore`.
`Agent` shall expose `readonly goals?: SessionGoalStore`.
All consumers must handle `undefined`.

Modify `packages/agent-core/src/session/rpc.ts`.
`updateSessionMetadata()` shall preserve the reserved `metadata.custom.goal` field.
It shall:

- read the existing `this.session.metadata.custom?.goal`
- reject a patch that contains `metadata.custom.goal`
- apply the existing shallow metadata update
- re-apply the previous `custom.goal` value when it existed

Modify `packages/agent-core/src/errors/codes.ts` and related error exports.
Add:

- `GOAL_ALREADY_EXISTS: 'goal.already_exists'`
- `GOAL_NOT_FOUND: 'goal.not_found'`
- `GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty'`
- `GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long'`
- `GOAL_STATUS_INVALID: 'goal.status_invalid'`
- `GOAL_METADATA_RESERVED: 'goal.metadata_reserved'`
- `GOAL_NOT_RESUMABLE: 'goal.not_resumable'`

Add matching `KIMI_ERROR_INFO` entries.
The `satisfies Record<KimiErrorCode, KimiErrorInfo>` check shall enforce complete metadata.

## Tests

Add `packages/agent-core/test/session/goal.test.ts`.

The tests shall cover:

- creating a goal writes `metadata.custom.goal`
- creating a goal waits for the metadata writer promise before asserting disk state
- empty objectives are rejected
- objectives longer than 4000 characters are rejected
- duplicate active and paused goals are rejected with `GOAL_ALREADY_EXISTS`
- replacing an active, paused, or terminal goal clears the old goal before creating the new goal
- `getGoal()` returns terminal snapshots until explicit clear
- `getActiveGoal()` returns `null` for paused and terminal goals
- absent `tokenBudget` returns `remainingTokens: null`
- present `tokenBudget` returns numeric `remainingTokens`
- token, turn, and wall-clock budget flags are computed independently
- `recordTokenUsage()` counts token deltas
- sub-second `recordWallClockUsage()` values accumulate in `wallClockMs`
- `incrementTurn()` counts goal continuation cycles
- `recordModelReport()` stores requested terminal state without changing `status`
- `pauseGoal()` and `resumeGoal()` update status
- `updateGoal({ status: 'complete' })` stores reason and evidence
- `updateGoal({ status: 'blocked' })` stores reason and evidence
- `updateGoal({ status: 'impossible' })` stores reason and evidence
- terminal updates reject runtime-owned and user-owned statuses when called through `updateGoal()`
- `markBudgetLimited()`, `markInterrupted()`, and `markError()` store runtime terminal states
- `cancelGoal({ actor: 'user' })` clears `metadata.custom.goal`
- `clearGoal()` is idempotent

These tests prove the durable state owner, lifecycle rules, budget math, evidence fields, and actor boundaries before audit, CLI, tools, or continuation code depends on them.

Add tests for `SessionAPIImpl.updateSessionMetadata()` in the nearest existing session RPC test file.
They shall prove generic metadata updates preserve active `custom.goal` and reject attempts to write `custom.goal` directly.

## Verification

Run:

```bash
pnpm --filter @moonshot-ai/agent-core test -- test/session/goal.test.ts
pnpm --filter @moonshot-ai/agent-core run typecheck
! rg -n "@moonshot-ai/agent-core" apps/kimi-code/src
```

This phase should not change `apps/kimi-code` behavior yet.
