# Phase 4c: Goal Continuation Loop

## Goal

Make `/goal` a real autonomous continuation mode.

This phase is complete when `TurnFlow` keeps the main agent working after a stopped model step while a goal is active, and stops when the goal is terminal, paused, interrupted, or over a hard budget.

## Background

`packages/agent-core/src/loop/run-turn.ts` already supports continuation after a terminal model step through `hooks.shouldContinueAfterStop`.
`packages/agent-core/src/agent/turn/index.ts` currently uses that hook for two things:

- flushing steered user messages
- running `HookEngine.triggerBlock('Stop')`

The existing external Stop hook path is deliberately capped by `stopHookContinuationUsed`.
That cap is correct for user-configured hooks.
It cannot implement goal mode by itself, because goal mode may need many continuations.

`PromptOrigin` in `packages/agent-core/src/agent/context/types.ts` already supports `system_trigger`.
The continuation loop can append hidden continuation prompts with `origin: { kind: 'system_trigger', name: 'goal_continuation' }`.

## Reason

The previous plans stored a goal and reminded the model, but `/goal X` still ran one normal turn and stopped.
That is goal tracking, not goal mode.

This phase adds the missing engine.
It uses the existing `shouldContinueAfterStop` hook point, but it does not reuse the one-shot external Stop hook cap.

## Concrete Changes

Create `packages/agent-core/src/agent/goal/continuation.ts`.
It shall export `GoalContinuationController`.

`GoalContinuationController` shall:

- be constructed inside one `TurnFlow.runTurn()` call
- keep per-turn continuation state in memory
- receive the outer turn `startedAt` timestamp and a `now()` dependency for tests
- maintain a `lastWallClockAccountedAt` checkpoint
- only run when `flags.enabled('goal-command')`
- only run for `agent.type === 'main'`
- only run when `agent.goals?.getActiveGoal()` returns an active goal
- stop when the goal is paused or terminal
- stop when a hard budget has been reached
- accept the latest model report from `UpdateGoal` as a Level-1 terminal decision
- append continuation prompts as user messages with `origin.kind === 'system_trigger'`
- call `agent.goals.incrementTurn(...)` once per stopped assistant step that participates in the goal loop
- call `agent.goals.recordWallClockUsage(...)` before each hard-budget check
- expose a `finalizeWallClock()` method so `TurnFlow.runTurn()` can record the final interval when the turn ends or throws

The controller shall use this decision order after a terminal model step:

1. If the goal disappeared, stop.
2. If the goal is paused, stop.
3. If the goal is terminal, stop.
4. Record the elapsed wall-clock delta since the last checkpoint.
5. If a model report asks for `complete`, `blocked`, or `impossible`, call `agent.goals.updateGoal(...)` with that status and stop.
6. If token, turn, or wall-clock budget is reached, call `agent.goals.markBudgetLimited(...)`, append one budget wrap-up prompt, and continue once.
7. If the budget wrap-up has already run, stop.
8. If `maxStepsPerTurn` would be exhausted by another continuation, handle it as described below.
9. Otherwise append a continuation prompt and continue.

The wall-clock budget check shall use the freshly recorded elapsed delta.
It must not depend only on `turnWorker()` cleanup, because cleanup runs after the whole continued goal turn ends.

The normal continuation prompt shall tell the model to:

- continue working toward the active goal
- use existing context and tools
- avoid asking the user unless a real blocker exists
- call `UpdateGoal` with reason and evidence when the goal is complete, blocked, or impossible

The budget wrap-up prompt shall tell the model to:

- stop starting new substantive work
- summarize progress
- list remaining work
- explain which budget was reached
- stop after the summary

Modify `packages/agent-core/src/agent/turn/index.ts`.
Pass `startedAt` from `turnWorker()` into the private `runTurn()` helper.
Inside that helper, construct `GoalContinuationController` once per outer turn.

Update `shouldContinueAfterStop` to preserve this order:

1. flush steered messages
2. run the existing external Stop hook with the existing one-continuation cap
3. run `GoalContinuationController.shouldContinueAfterStop(ctx)`

Pass the full `LoopStoppedStepContext` to the goal controller.
Do not change the public `LoopHooks` API.

Wrap the inner `runTurn(...)` call in a `finally` block that calls `goalContinuationController.finalizeWallClock()` when:

- the feature flag is enabled
- the agent is the main agent
- the current turn still owns `turnId`
- the same goal still exists and has not been cleared

This records the final elapsed interval for normal completion, thrown errors, and cancellations where the same goal still exists.

Reconcile `maxStepsPerTurn` with goal continuation.
`packages/agent-core/src/loop/run-turn.ts` enforces `maxSteps` before starting the next step.
During goal mode, the continuation controller shall inspect `ctx.stepNumber` and `loopControl?.maxStepsPerTurn` before returning `{ continue: true }`.
If there is at most one model step left under the configured cap, it shall:

- mark the goal `budget_limited`
- use a reason such as `Model step limit reached`
- append a wrap-up prompt and continue only when exactly one model step remains
- stop without triggering `MaxStepsExceededError` when no model step remains

If `MaxStepsExceededError` still escapes during an active goal, `turnWorker()` shall map it to `markBudgetLimited()` rather than `markError()`.
This keeps configured step caps from masquerading as runtime failures.

In `turnWorker()`, mark active goals when the outer turn ends abnormally:

- if the turn is cancelled and the goal is still active, call `markInterrupted({ reason })`
- if the turn fails and the goal is still active, call `markError({ reason })`
- do not overwrite `paused`, `cancelled`, or other terminal states

Do not mark interruption when `/goal pause`, `/goal cancel`, or `/goal clear` has already changed the goal state.

## Tests

Add tests to `packages/agent-core/test/agent/turn.test.ts` or create `packages/agent-core/test/agent/goal-continuation.test.ts`.

The tests shall prove:

- the main agent auto-continues after a stopped step when a goal is active
- subagents do not auto-continue for goals
- no continuation happens when the feature flag is disabled
- the existing external Stop hook still gets its one continuation before goal continuation runs
- the external Stop hook cap does not cap goal continuations
- continuation prompts use `origin.kind === 'system_trigger'` and `name === 'goal_continuation'`
- `incrementTurn()` runs once per stopped goal step
- a model report from `UpdateGoal` is converted into a terminal `complete` status
- `blocked` and `impossible` model reports become distinct terminal statuses
- paused goals do not continue
- token, turn, and wall-clock budget limits stop the loop
- wall-clock budget uses live elapsed time before `turnWorker()` cleanup
- budget limits get one wrap-up continuation and then stop
- `maxStepsPerTurn` is mapped to `budget_limited`, not `error`, during an active goal
- `maxStepsPerTurn` does not throw when the controller can stop before exceeding it
- cancelled turns mark active goals `interrupted`
- failed turns mark active goals `error`

These tests prove the missing loop, the stop conditions, the interaction with the existing Stop hook, and the runtime-owned terminal states.

## Verification

Run:

```bash
pnpm --filter @moonshot-ai/agent-core test -- test/agent/goal-continuation.test.ts test/agent/turn.test.ts
pnpm --filter @moonshot-ai/agent-core run typecheck
```

This phase should make `/goal` continue autonomously.
It should still use model self-report as the completion signal.
Phase 4d replaces that weak signal with an independent evaluator.
