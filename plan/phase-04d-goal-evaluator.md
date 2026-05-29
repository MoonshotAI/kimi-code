# Phase 4d: Goal Evaluator

## Goal

Add an independent evaluator for goal completion and progress.

This phase is complete when the goal continuation loop runs a separate no-tool evaluator after each stopped main-agent step and uses the evaluator verdict, not the main model's self-report alone, to decide whether to continue.

## Background

Phase 4c adds autonomous continuation through `TurnFlow` and `GoalContinuationController`.
It accepts the model's latest `UpdateGoal` report as a Level-1 terminal signal.

`packages/agent-core/src/loop/types.ts` passes `llm` to `ShouldContinueAfterStopHook`.
That gives the continuation controller access to the same provider abstraction without adding a new SDK surface.
`LLM.chat()` returns `LLMChatResponse.usage`, so evaluator token cost can be counted explicitly.

The evaluator shall inspect conversation context only.
It shall not run tools and shall not inspect files independently.

## Reason

Model self-report is too weak for goal mode.
The model that did the work may declare success too early or miss that a stated validation condition failed.

An evaluator gives the runtime a separate decision point after each stopped step.
It also gives `blocked`, `impossible`, no-progress, and hard-budget behavior a clear place to live.

## Concrete Changes

Create `packages/agent-core/src/agent/goal/evaluator.ts`.
It shall export:

- `GoalEvaluator`
- `GoalEvaluatorVerdict`
- `GoalEvaluatorInput`
- `GoalEvaluatorResult`

`GoalEvaluatorVerdict` shall include:

- `continue`
- `complete`
- `blocked`
- `impossible`
- `no_progress`

`GoalEvaluator` shall:

- take the active `GoalSnapshot`
- take a bounded slice or summary of `agent.context.messages`
- take the latest model report from `UpdateGoal`, when present
- call the provided `llm` without tools for the initial implementation
- request strict JSON output
- validate the parsed JSON
- return a typed result with `verdict`, `reason`, and `evidence`
- return evaluator `usage`
- return a typed evaluator error when JSON is invalid or the evaluator call fails

The evaluator prompt shall ask:

- whether the completion criterion has been met
- whether required validation evidence exists
- whether the model is blocked by user input or an external condition
- whether the objective is impossible as stated
- whether the last step made meaningful progress
- whether another continuation is likely to help

Modify `packages/agent-core/src/agent/goal/continuation.ts`.
After Phase 4d, the decision order shall be:

1. Stop if the goal disappeared, paused, or terminal.
2. Check hard budgets.
3. If a hard budget is reached, run the one-time budget wrap-up from Phase 4c.
4. Run `GoalEvaluator`.
5. Count evaluator token usage through `agent.goals.recordTokenUsage({ agentId: 'main', agentType: 'main', source: 'goal_evaluator' })`.
6. Record the verdict with `agent.goals.recordEvaluatorVerdict(...)`.
7. If the evaluator returns `complete`, `blocked`, or `impossible`, call `agent.goals.updateGoal(...)` and stop.
8. Re-check hard budgets because the evaluator call itself may have reached the token budget, and run the Phase 4c budget-limited path if a budget is reached.
9. If the evaluator returns `no_progress`, rely on `recordEvaluatorVerdict()` to increment `consecutiveNoProgressTurns`.
10. If the stored `noProgressTurnLimit` is reached, call `agent.goals.updateGoal({ status: 'blocked', ... })` and stop.
11. If the evaluator fails repeatedly and `failureTurnLimit` is reached, call `agent.goals.markError(...)` and stop.
12. Otherwise append the normal continuation prompt and continue.

The latest model report from `UpdateGoal` shall be evidence for the evaluator.
It shall not directly end the goal once Phase 4d is implemented.

The first implementation may use the main agent `llm`.
Do not hard-code that as the only design.
Leave `GoalEvaluator` with a constructor seam for a future lightweight judge model selected from config.

Modify `packages/agent-core/src/session/goal.ts`.
`recordEvaluatorVerdict()` shall:

- store the latest verdict, reason, and evidence
- reset `consecutiveNoProgressTurns` when progress is observed
- increment `consecutiveNoProgressTurns` for `no_progress`
- reset or increment `consecutiveFailureTurns` based on evaluator success
- write metadata
- append `goal.evaluate`

`updateGoal()` shall store the evaluator reason and evidence when the evaluator ends a goal.

## Tests

Add `packages/agent-core/test/agent/goal-evaluator.test.ts`.

The tests shall prove:

- valid evaluator JSON parses into a typed result
- invalid JSON returns an evaluator error
- evaluator errors are recorded without crashing the turn loop
- evaluator token usage is counted toward the goal token budget
- evaluator token usage can trigger `budget_limited`
- `complete` verdict marks the goal complete and stops continuation
- `blocked` verdict marks the goal blocked and stops continuation
- `impossible` verdict marks the goal impossible and stops continuation
- `continue` verdict appends a continuation prompt
- `no_progress` increments the no-progress counter
- reaching `noProgressTurnLimit` marks the goal blocked
- repeated evaluator failures reaching `failureTurnLimit` marks the goal error
- a model `UpdateGoal` report is passed to the evaluator as evidence
- a model `UpdateGoal` report alone does not end the goal when evaluator says `continue`
- `GoalEvaluator` can be constructed with an injected judge LLM for future lightweight-evaluator support

Add or extend a continuation integration test.
It shall run at least two stopped steps and prove the evaluator decides between continuing and stopping.

These tests prove the Level-2 behavior that the research identified as missing: a separate judge controls continuation and terminal state.

## Verification

Run:

```bash
pnpm --filter @moonshot-ai/agent-core test -- test/agent/goal-evaluator.test.ts test/agent/goal-continuation.test.ts
pnpm --filter @moonshot-ai/agent-core run typecheck
```

This phase should make completion evaluator-driven.
It should not add headless CLI support or event-stream exit codes.
