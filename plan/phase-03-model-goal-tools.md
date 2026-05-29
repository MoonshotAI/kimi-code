# Phase 3: Model Goal Tools

## Goal

Add main-agent goal tools to `packages/agent-core`.

This phase is complete when the main agent can create an explicit goal on the user's behalf, read the current goal, and report a terminal goal judgment with reason and evidence.

## Background

Phase 1a creates `SessionGoalStore`.
Phase 2 exposes deterministic user and SDK lifecycle controls.

The model-facing tool registry lives in `packages/agent-core/src/agent/tool/index.ts`.
The default main-agent tool list lives in `packages/agent-core/src/profile/default/agent.yaml`.
Tool implementations live under `packages/agent-core/src/tools/builtin`.

`packages/agent-core/src/profile/default/agent.yaml` is static.
The feature flag gates built-in tool registration in `ToolManager.initializeBuiltinTools()`.
When the flag is disabled, the profile may list goal tools, but no tool instances are registered and `loopTools` does not expose them.

## Reason

The goal should be structured state, not text the model parses from a slash command.

`CreateGoal` supports model-assisted intake in normal conversation and future command refinements.
`GetGoal` gives the model the current objective, budget, and evaluator state.
`UpdateGoal` captures the model's completion or blocker claim as evidence.

`UpdateGoal` shall not be the final authority once the continuation controller and evaluator exist.
It records a model report.
Phase 4c may accept that report as a Level-1 self-report.
Phase 4d upgrades the decision to an independent evaluator.

## Concrete Changes

Create `packages/agent-core/src/tools/builtin/goal/create-goal.ts`.
`CreateGoalTool` shall:

- implement `BuiltinTool<CreateGoalInput>`
- use `name = 'CreateGoal'`
- be main-agent-only
- read and write through `agent.goals`
- accept `objective`, optional `completionCriterion`, optional `budgetLimits`, and optional `replace`
- reject empty objectives
- reject objectives longer than 4000 characters
- return `GOAL_NOT_FOUND` or a goal-specific typed error as an `ExecutableToolResult` with `isError: true`
- call `agent.goals.createGoal(...)`
- return the created `GoalSnapshot`

Create `packages/agent-core/src/tools/builtin/goal/create-goal.md`.
The description shall tell the model:

- call `CreateGoal` only when the user explicitly asks to start a goal or when a host goal-intake prompt asks it to do so
- do not create a goal for greetings, ordinary questions, or vague requests that lack a verifiable completion condition
- ask the user for the missing completion criterion when the goal is vague
- respect clear user insistence after warning about vague or risky wording
- include a `completionCriterion` when the user provides one or when it can be stated without inventing requirements

Create `packages/agent-core/src/tools/builtin/goal/get-goal.ts`.
`GetGoalTool` shall:

- implement `BuiltinTool<{}>`
- use `name = 'GetGoal'`
- be main-agent-only
- return `{ goal: null }` when `agent.goals` is `undefined`
- return `{ goal: null }` when the store has no current goal
- return active, paused, or terminal goal snapshots
- include budget state, evaluator state, and model-report state

Create `packages/agent-core/src/tools/builtin/goal/get-goal.md`.
The description shall tell the model to use `GetGoal` before deciding whether to continue, report completion, report a blocker, or respect a pause.

Create `packages/agent-core/src/tools/builtin/goal/update-goal.ts`.
`UpdateGoalTool` shall:

- implement `BuiltinTool<UpdateGoalInput>`
- use `name = 'UpdateGoal'`
- be main-agent-only
- accept `status`, `reason`, and optional `evidence`
- accept only `complete`, `blocked`, and `impossible`
- reject `active`, `paused`, `cancelled`, `budget_limited`, `interrupted`, `error`, missing `status`, missing `reason`, and unknown strings
- return `GOAL_NOT_FOUND` when there is no current active goal
- call `agent.goals.recordModelReport({ requestedStatus, reason, evidence })`
- not call `agent.goals.updateGoal()` directly
- return the current `GoalSnapshot` and `goalBudgetReport`

Create `packages/agent-core/src/tools/builtin/goal/update-goal.md`.
The description shall tell the model:

- report `complete` only when no required work remains
- report `blocked` only when the same external or user-input blocker prevents progress
- report `impossible` when the objective cannot be completed as stated
- include a short reason
- include validation evidence when available
- expect the continuation controller or evaluator to decide whether the report ends the goal

Modify `packages/agent-core/src/tools/builtin/index.ts`.
Export the new goal tools.

Modify `packages/agent-core/src/agent/tool/index.ts`.
Import `flags` from `#/flags`.
`ToolManager.initializeBuiltinTools()` shall add these tools only when:

- `flags.enabled('goal-command')`
- `this.agent.type === 'main'`

Use the existing conditional array-entry style for consistency.

Modify `packages/agent-core/src/profile/default/agent.yaml`.
Add:

- `CreateGoal`
- `GetGoal`
- `UpdateGoal`

Do not add goal tools to explicit subagent profile tool lists in `packages/agent-core/src/profile/default/*.yaml`.

## Tests

Add `packages/agent-core/test/tools/goal.test.ts`.

The tests shall cover:

- `CreateGoalTool` creates a goal through `SessionGoalStore`
- `CreateGoalTool` rejects empty and too-long objectives
- `CreateGoalTool` passes `completionCriterion`, budgets, and `replace`
- `CreateGoalTool` is unavailable or returns an error when `agent.goals` is `undefined`
- `GetGoalTool` returns `{ goal: null }` when no goal exists
- `GetGoalTool` returns active goal state
- `GetGoalTool` returns paused and terminal snapshots
- `GetGoalTool` includes remaining budgets and evaluator fields
- `UpdateGoalTool` accepts only `complete`, `blocked`, and `impossible`
- `UpdateGoalTool` requires a non-empty `reason`
- invalid `UpdateGoalTool` calls do not mutate `status`
- `UpdateGoalTool` records a model report without making the goal terminal
- `UpdateGoalTool` returns `GOAL_NOT_FOUND` when no active goal exists
- all goal tools return `isError: true` when constructed with a non-main agent
- tool descriptions use the imported Markdown files

Update `packages/agent-core/test/profile/default-agent-profiles.test.ts`.
It shall prove the default `agent` profile lists the three goal tools and explicit subagent profiles do not.

Add or update a `ToolManager` registration test.
It shall prove:

- with `goal-command` disabled, goal tools are absent from `toolInfos()` and `loopTools`
- with `goal-command` enabled, the main agent exposes goal tools when active in the profile
- with `goal-command` enabled, subagents do not expose goal tools

These tests prove the model-visible JSON contract, error conversion path, feature gate, main-agent boundary, and the key semantic change that `UpdateGoal` records evidence rather than directly ending the goal.

## Verification

Run:

```bash
pnpm --filter @moonshot-ai/agent-core test -- test/tools/goal.test.ts test/profile/default-agent-profiles.test.ts
pnpm --filter @moonshot-ai/agent-core run typecheck
```

This phase should not inject goal reminders and should not auto-continue turns.
