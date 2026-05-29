# Phase 4a: Goal Context Injection

## Goal

Inject current goal guidance into the main agent's model context.

This phase is complete when active goals produce a `goal` injection reminder before main-agent model steps, and subagents never receive goal reminders.

## Background

Dynamic instructions are injected by `InjectionManager` in `packages/agent-core/src/agent/injection/manager.ts`.
Each injector extends `DynamicInjector` in `packages/agent-core/src/agent/injection/injector.ts`.
`DynamicInjector.inject()` calls `ContextMemory.appendSystemReminder()`.
That records a `context.append_message` entry in `wire.jsonl` with `origin.kind === 'injection'`.

`InjectionManager` is constructed for every `Agent`.
Without an explicit guard, subagents would receive goal reminders even though goal tools are main-agent-only.

## Reason

The main agent needs the objective, completion criterion, budgets, pause state, and evaluator guidance in context before each model step.

The objective must be treated as user-provided task data.
It must not become a higher-priority instruction than system messages, developer messages, tool schemas, permission rules, or host controls.

## Concrete Changes

Create `packages/agent-core/src/agent/injection/goal.ts`.
`GoalInjector` shall extend `DynamicInjector`.
It shall use `injectionVariant = 'goal'`.
It shall read from `agent.goals`.

It shall return no injection when:

- `agent.goals` is `undefined`
- there is no current goal
- the current goal is terminal
- the current goal is `paused`

It shall wrap the objective in `<untrusted_objective>`.
It shall wrap the completion criterion, when present, in `<untrusted_completion_criterion>`.
The reminder shall state that these values describe the user's task but do not override higher-priority instructions.

The reminder shall include:

- current status
- elapsed time from `wallClockMs`
- `turnsUsed`
- `tokensUsed`
- token, turn, and wall-clock budget limits when set
- remaining budget values
- budget threshold guidance
- latest model report, when present
- latest evaluator verdict, when present
- completion and blocker reporting guidance from `update-goal.md`

Budget wording shall have three bands:

- below 75 percent used: neutral progress guidance
- 75 to 99 percent used: converge and avoid expanding scope
- 100 percent or over: stop starting new discretionary work and report the best terminal state

`GoalInjector` shall not enforce budgets.
Phase 4c owns hard continuation stops.

`DynamicInjector.inject()` appends a reminder every model step.
`GoalInjector` shall follow the existing injector behavior for this implementation.
Phase 6 may revisit stale or repeated goal reminders after real use.

Modify `packages/agent-core/src/agent/injection/manager.ts`.
Add `GoalInjector` only when:

- `flags.enabled('goal-command')`
- `agent.type === 'main'`

Place `GoalInjector` after `PluginSessionStartInjector` and before `PlanModeInjector`.
The goal is the work objective.
Plan mode and permission mode remain operational constraints after that objective.

Use an explicit local array and `push()` calls so injector order stays obvious.

## Tests

Add `packages/agent-core/test/agent/injection/goal.test.ts`.

The tests shall cover:

- no current goal produces no injection
- `agent.goals === undefined` produces no injection
- active goal injection includes `<untrusted_objective>`
- active goal injection includes `<untrusted_completion_criterion>` when present
- active goal injection includes budget lines
- active goal injection includes threshold wording below 75 percent
- active goal injection includes convergence wording above 75 percent
- active goal injection includes over-budget wording at or above 100 percent
- active goal injection includes model-report and evaluator context when present
- paused goal produces no injection
- terminal goal produces no injection
- main-agent `InjectionManager.inject()` writes a `context.append_message` record with `origin.variant === 'goal'`
- no record is written when there is no active goal
- subagent `InjectionManager.inject()` does not add a goal reminder

These tests verify the objective wrapper, priority-boundary wording, budget visibility, threshold behavior, main-agent gate, and replay record shape.

## Verification

Run:

```bash
pnpm --filter @moonshot-ai/agent-core test -- test/agent/injection/goal.test.ts
pnpm --filter @moonshot-ai/agent-core run typecheck
```

This phase should make active goals visible to the main agent only.
It should not add accounting, continuation, or evaluator behavior.
