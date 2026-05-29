# Phase 5: End-To-End Integration And Gates

## Goal

Verify the complete `/goal` flow across `apps/kimi-code`, `packages/node-sdk`, and `packages/agent-core`.

This phase is complete when a user can start a goal, the main agent can work through automatic continuations, the evaluator can end the goal, user controls can pause or clear it, and audit evidence remains in `agents/main/wire.jsonl`.

## Background

The earlier phases add the pieces separately:

- Phase 1a: `SessionGoalStore` owns current goal state in `state.json`
- Phase 1b: `SessionGoalStore` writes `goal.*` audit records to `agents/main/wire.jsonl`
- Phase 2: `Session` and `/goal` expose user lifecycle controls
- Phase 3: `CreateGoal`, `GetGoal`, and `UpdateGoal` expose model-facing goal operations
- Phase 4a: `GoalInjector` adds goal context before main-agent model steps
- Phase 4b: `TurnFlow` updates token and wall-clock counters
- Phase 4c: `GoalContinuationController` keeps working after stopped steps
- Phase 4d: `GoalEvaluator` decides whether to continue or stop

## Reason

Goal mode crosses package boundaries and runtime hooks.
Unit tests can prove modules locally, but they cannot prove that the command, SDK, state store, tools, injection, continuation, evaluator, budgets, and audit records work as one product flow.

This phase protects against the original mistake: a feature that stores a goal but does not loop.

## Concrete Changes

Add integration coverage using existing harnesses where possible.
Prefer extending existing tests over creating many new files.

Before writing integration tests, confirm these decisions from earlier phases are implemented:

- `goal.*` records use `agents/main/wire.jsonl` as the canonical audit file
- replay ignores `goal.*` records as state input
- goal injection and continuation are main-agent-only
- token accounting includes session agents
- wall-clock accounting is main-agent-only and advances before continuation budget checks
- terminal snapshots remain in `state.json` until user clear or replacement
- hard budget stops happen in `GoalContinuationController`
- evaluator verdicts, not model reports alone, end goals after Phase 4d
- evaluator token usage counts toward the goal token budget
- `maxStepsPerTurn` is reconciled with goal mode as a budget limit, not a generic error

Add one `packages/agent-core` harness test that creates a `Session`, creates a goal through `SessionAPIImpl`, and runs a deterministic main-agent flow.

The fake model flow shall:

1. receive the active goal injection
2. call `GetGoal`
3. do one useful step
4. stop
5. receive a `goal_continuation` system-trigger message
6. do a second useful step
7. call `UpdateGoal` with a completion report
8. stop
9. receive an evaluator `complete` verdict

The test shall inspect:

- `state.json` contains active goal after creation and `flushMetadata()`
- model context contains the `GoalInjector` reminder
- `GetGoal` returns the current goal
- goal token accounting includes the main-agent steps
- evaluator token accounting is included when the evaluator runs
- `UpdateGoal` records a model report without directly ending the goal
- evaluator verdict marks the goal `complete`
- terminal `complete` snapshot remains visible through `getGoal()`
- `agents/main/wire.jsonl` contains `goal.create`, `goal.account_usage`, `goal.continuation`, `goal.report`, `goal.evaluate`, and `goal.update`
- no `goal.*` records appear in subagent `wire.jsonl` files except session-wide token accounting if the implementation records token deltas only in the main audit sink

Add a budget integration branch.
It shall create a goal with a small turn or token budget and prove:

- the continuation loop stops at the budget
- `markBudgetLimited()` sets status `budget_limited`
- the one-time budget wrap-up prompt runs
- no further continuation prompt is appended after wrap-up

Add a wall-clock budget branch.
It shall use an injected clock and prove:

- elapsed wall-clock time is recorded before the controller checks budgets
- `--max-minutes` can stop a continued goal before `turnWorker()` cleanup

Add a `maxStepsPerTurn` branch.
It shall set `loopControl.maxStepsPerTurn` and prove:

- the continuation controller stops before `MaxStepsExceededError` when possible
- the goal becomes `budget_limited` with a step-limit reason
- no active goal is marked `error` only because the configured step cap was reached

Add user-control integration coverage.
It shall prove:

- `/goal pause` changes status to `paused` and stops automatic continuation
- `/goal resume` changes status to `active` and starts work again
- `/goal clear` removes the current goal
- `/goal cancel` clears an active goal and writes `goal.update(status: cancelled)` before `goal.clear`
- `/goal` status shows terminal snapshots until clear

Review feature-flag behavior across packages.
With `goal-command` disabled:

- `apps/kimi-code/src/tui/commands/resolve.ts` returns `{ kind: 'message', input: '/goal Ship feature X' }`
- `ToolManager.loopTools` does not include goal tools
- `GoalInjector` does not run
- `GoalContinuationController` does not continue

With `goal-command` enabled:

- `/goal Ship feature X` dispatches to `handleGoalCommand()`
- main-agent `ToolManager.loopTools` includes goal tools when active in the profile
- `GoalInjector` can run for the main agent
- `GoalContinuationController` can continue the main agent

Review exports.
`packages/agent-core/src/index.ts` shall export only the goal types needed by `packages/node-sdk`.
Keep these internal unless a package boundary requires them:

- `SessionGoalStore`
- `SessionGoalState`
- `goal.*` record payload types
- `GoalContinuationController`
- `GoalEvaluator`

`packages/node-sdk/src/index.ts` shall expose the public SDK types and goal lifecycle methods.
It shall not expose `Session.updateGoal()`.

If this work is prepared for a PR, document `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND` and its default-off state in the appropriate user or developer docs.

## Tests

Add `packages/agent-core/test/harness/goal-session.test.ts` or the nearest existing harness test file.

The test shall cover the full core runtime path:

- `SessionAPIImpl.createGoal()` stores active state
- a generated main-agent step receives the goal injection
- `GetGoalTool` returns current state
- goal token and wall-clock accounting update counters
- `GoalContinuationController` appends `goal_continuation`
- `GoalEvaluator` returns `continue` and then `complete`
- `UpdateGoalTool` records model evidence without bypassing the evaluator
- terminal evidence remains in `state.json`
- audit evidence remains in `agents/main/wire.jsonl`
- resume reads terminal status from `state.json`, not `goal.*` records

Add resume scenarios to the same harness test or a focused adjacent test:

- create an active goal, flush metadata, resume the session, and verify `GetGoalTool` returns the same goal as `paused`
- pause a goal, resume the session, and verify auto-continuation does not restart until `/goal resume`
- complete a goal, resume the session, and verify bare `/goal` can still show the terminal snapshot
- clear a goal, resume the session, and verify `GetGoalTool` returns `{ goal: null }`

Add an `apps/kimi-code` dispatch-level test near the existing command tests.
It shall prove `dispatchInput(host, '/goal Ship feature X')` goes through the real slash-command resolver, creates the goal, and sends `Ship feature X` as normal input.

Add cross-package feature-flag tests or focused tests that prove the same behavior:

- disabled command becomes a normal message
- disabled tools are absent
- disabled injection and continuation do not run
- enabled command routes to `handleGoalCommand()`
- enabled tools are present for the main agent
- enabled tools are absent for subagents
- enabled injection and continuation are main-agent-only

Add integration error-path assertions:

- duplicate `/goal` creation surfaces a command error without sending a second normal input
- `/goal cancel` with no current goal surfaces a command error
- `UpdateGoalTool` with no active goal returns an error result
- evaluator invalid JSON records an evaluator error and obeys `failureTurnLimit`
- replacing an existing goal writes `goal.clear` for the old goal before `goal.create` for the new goal

These tests are sufficient because they exercise the same command path, SDK path, model tools, loop hooks, and persistence path used in a real session.

## Verification

Run:

```bash
pnpm --filter @moonshot-ai/agent-core test -- test/session/goal.test.ts test/agent/injection/goal.test.ts test/tools/goal.test.ts test/agent/goal-continuation.test.ts test/agent/goal-evaluator.test.ts test/harness/goal-session.test.ts
pnpm --filter @moonshot-ai/kimi-code test -- test/tui/commands/goal.test.ts test/tui/commands/registry.test.ts test/tui/commands/resolve.test.ts
pnpm run typecheck
pnpm run lint
```

Manual smoke verification for PR readiness:

```bash
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=true pnpm --filter @moonshot-ai/kimi-code dev
```

In the TUI, type `/goal Ship feature X`.
Verify that the goal is created, the accepted objective is sent as normal input, the agent continues after stopped steps, and `/goal` shows the final terminal status after completion.

If this work is prepared for a PR, run the repository's `gen-changesets` skill before opening the PR.
