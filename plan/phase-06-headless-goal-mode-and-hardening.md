# Phase 6: Headless Goal Mode And Hardening

## Goal

Add non-interactive goal-mode support and harden behavior that can only be judged after the full loop exists.

This phase is complete when goal mode can run in a headless command path with machine-readable outcome data, and the implemented feature has explicit decisions for stale reminders, repeated injections, vague-goal intake, and budget behavior.

## Background

Phases 1a through 5 build the interactive goal mode.
They store durable state, expose user controls, inject goal context, account usage, continue automatically, run an evaluator, and verify the full TUI flow.

The research review also identified non-interactive goal mode as part of mature `/goal` behavior.
This repository already has CLI prompt paths under `apps/kimi-code/src/cli`.
Those paths need separate planning because they do not share the TUI slash-command loop.

## Reason

Goal mode is most useful for long-running work and CI-style checks.
Interactive-only support leaves out the headless use case.

Some behavior also needs real-session evidence:

- repeated `GoalInjector` reminders
- repeated `goal_continuation` prompts
- stale historical reminders after resume
- vague or non-verifiable goals
- evaluator strictness
- evaluator model choice
- budget defaults and budget stop wording
- terminal snapshot retention
- context-clear behavior while a goal exists

This phase keeps those concerns visible without blocking the first working interactive implementation.

## Concrete Changes

Add a headless goal entry point in the existing CLI prompt path.
Use the existing `apps/kimi-code/src/cli` structure rather than creating a second runtime.

The headless path shall support a command equivalent to:

```text
kimi -p "/goal <objective>"
```

or the nearest existing prompt-mode syntax in this repository.

It shall:

- create or resume a session
- parse the `/goal` command with the same objective cap and budget options as the TUI
- treat a resumed stale active goal as paused unless the headless invocation explicitly asks to resume it
- start the main-agent turn
- wait for the goal to reach a terminal state
- stream normal assistant output
- emit a final machine-readable goal summary when requested
- return distinct exit codes for success, blocked, impossible, budget-limited, interrupted, and error

Add goal events to the SDK event stream if the current event model can support them cleanly.
Prefer a small event set:

- `goal.created`
- `goal.updated`
- `goal.evaluated`
- `goal.continued`
- `goal.clear`

Do not expose internal store classes through the SDK.

Review stale injected reminders.
Because `GoalInjector` writes `context.append_message` records, replay can restore historical goal reminders.
If real sessions show stale budget numbers confusing the model, design a replacement strategy:

- either replace the previous goal reminder instead of appending each step
- or keep appending but make the reminder explicitly say it is a fresh runtime snapshot

Review continuation prompt history.
`GoalContinuationController` appends `goal_continuation` user messages as real conversation history.
Long goals can produce repetitive replay history.
Decide whether to accept this transcript growth, summarize old continuation prompts during compaction, or replace continuation prompts with a lighter internal marker.

Review vague-goal intake.
Phase 3 gives the model a `CreateGoal` tool and a well-formedness rubric.
The TUI `/goal` path in Phase 2 remains deterministic.
After dogfooding, decide whether `/goal <objective>` should stay deterministic or become model-assisted intake:

- deterministic create is faster and predictable
- model-assisted intake catches vague, compound, or non-goal input before state is created

If model-assisted intake is adopted, add a new phase rather than changing Phase 2 in place.
That phase should route `/goal <objective>` to a structured intake prompt and let `CreateGoalTool` create the state only when the objective is well formed or the user insists.

Review hard budget defaults.
Confirm whether `DEFAULT_GOAL_TURN_BUDGET` is enough as the default safety cap.
Decide whether to add default token or wall-clock budgets in config.

Review evaluator model choice.
Phase 4d uses the main agent `llm` first, with a constructor seam for a future judge model.
Decide whether to add a config field for a small or fast evaluator model after measuring cost and judgment quality.

Review terminal snapshot retention.
Terminal goals intentionally remain in `state.json` until `/goal clear` or replacement.
Decide whether to keep that indefinitely, expire terminal snapshots after a bounded number of resumes, or archive the last terminal summary somewhere outside `metadata.custom.goal`.

Review context clear behavior.
Kimi goal state lives in `Session.metadata.custom.goal`, so clearing agent context does not automatically clear the goal.
Decide whether the existing context-clear command should clear, pause, or leave goals alone.
If it leaves goals alone, document the difference from agents where `/clear` also clears the active goal.

Review blocked behavior.
Confirm that terminal `blocked` state, reason, evidence, and `/goal` status give enough user feedback.
If not, add a user-visible notice event or a TUI panel.

## Tests

Add headless integration tests near the existing CLI prompt tests.

The tests shall cover:

- headless `/goal` creates a goal and waits for terminal `complete`
- headless `blocked`, `impossible`, `budget_limited`, `interrupted`, and `error` outcomes return distinct exit codes
- optional machine-readable summary includes goal id, status, reason, budgets, and evidence
- disabled `goal-command` flag treats `/goal ...` as ordinary prompt text or returns the existing feature-disabled behavior
- headless runs preserve `goal.*` audit records

Extend `packages/agent-core/test/harness/goal-session.test.ts` or add adjacent focused tests for hardening items:

- replayed historical goal reminders do not create new `GoalInjector` output without an active goal
- repeated active-goal reminders are either accepted by test contract or replaced by the chosen dedupe strategy
- repeated `goal_continuation` prompts are either accepted by test contract or handled by the chosen compaction or dedupe strategy
- terminal `blocked` status retains reason and evidence across resume
- budget wrap-up text runs once
- `DEFAULT_GOAL_TURN_BUDGET` prevents an endless loop when the evaluator keeps returning `continue`

These tests are sufficient because they cover the surfaces not exercised by the interactive happy path: headless execution, exit semantics, replay history, and loop safety caps.

## Verification

Run:

```bash
pnpm --filter @moonshot-ai/agent-core test -- test/harness/goal-session.test.ts
pnpm --filter @moonshot-ai/kimi-code test -- test/cli
pnpm run typecheck
pnpm run lint
```

Manual smoke verification:

```bash
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=true pnpm --filter @moonshot-ai/kimi-code dev -- -p "/goal Run the focused goal tests and stop when they pass."
```

Before release, inspect one real exported session.
Confirm that `state.json`, `agents/main/wire.jsonl`, and the visible transcript match the contracts in Phases 1a through 5.
