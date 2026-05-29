# Phase 2: SDK API And `/goal` Command Surface

## Goal

Expose goal lifecycle control through `packages/node-sdk`, then connect the `/goal` slash command in `apps/kimi-code` to that API.

This phase is complete when a user can start, inspect, pause, resume, replace, cancel, and clear a goal from the TUI without importing `@moonshot-ai/agent-core` into `apps/kimi-code`.

## Background

`KimiTUI.handleUserInput()` in `apps/kimi-code/src/tui/kimi-tui.ts` sends text to `slashCommands.dispatchInput()`.
`apps/kimi-code/src/tui/commands/dispatch.ts` maps built-in command names to handlers.
`apps/kimi-code/src/tui/commands/registry.ts` owns built-in command metadata and availability.

The public SDK class is `packages/node-sdk/src/session.ts`.
It calls `SDKRpcClient` in `packages/node-sdk/src/rpc.ts`, which calls `CoreAPI` in `packages/agent-core/src/rpc/core-api.ts`.
`SessionAPIImpl` in `packages/agent-core/src/session/rpc.ts` is the core session-scoped implementation.

`apps/kimi-code/src/tui/commands/resolve.ts` sends a disabled experimental slash command to the model as a normal message.
This phase shall keep that behavior and test it.

## Reason

Goal mode needs user control.
The earlier plan only had creation and cancellation.
That would leave users without status, pause, resume, clear, or explicit replacement.

The command surface must also enforce objective length and hard budget options before the runtime continuation loop exists.

## Concrete Changes

Modify `packages/agent-core/src/flags/registry.ts`.
Add the `goal-command` flag with env var `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND` and default `false`.

Modify `packages/agent-core/src/rpc/core-api.ts`.
Export goal payload and result types from `packages/agent-core/src/session/goal.ts`.
Add these session-scoped methods to `SessionAPI`:

- `createGoal`
- `getGoal`
- `pauseGoal`
- `resumeGoal`
- `cancelGoal`
- `clearGoal`

Do not require `agentId`.
`CoreAPI` shall add `sessionId` when it wraps `SessionAPI`.

Modify `packages/agent-core/src/session/rpc.ts`.
Delegate the goal methods to `this.session.goals`.

Modify `packages/node-sdk/src/types.ts`.
Export:

- `CreateGoalInput`
- `GoalBudgetLimits`
- `GoalSnapshot`
- `GoalStatus`
- `GoalToolResult`
- `UpdateGoalControlInput` if needed for pause, resume, cancel, and clear

Modify `packages/node-sdk/src/rpc.ts`.
Add forwarding methods for the goal RPC calls.

Modify `packages/node-sdk/src/session.ts`.
Add:

- `Session.createGoal(input)`
- `Session.getGoal()`
- `Session.pauseGoal(input?)`
- `Session.resumeGoal(input?)`
- `Session.cancelGoal(input?)`
- `Session.clearGoal(input?)`

Do not add public `Session.updateGoal()`.
Model terminal updates are handled by `UpdateGoalTool` in Phase 3.

Create `apps/kimi-code/src/tui/commands/goal.ts`.
It shall parse:

```text
/goal
/goal status
/goal <objective>
/goal replace <objective>
/goal --max-tokens <positive-integer> <objective>
/goal --max-turns <positive-integer> <objective>
/goal --max-minutes <positive-integer> <objective>
/goal -- <objective-that-may-start-with-dash>
/goal pause
/goal resume
/goal cancel
/goal clear
```

Parser rules:

- bare `/goal` and `/goal status` show the current goal snapshot
- `pause`, `resume`, `cancel`, `clear`, and `replace` are reserved subcommands only when they are the first argument
- use `/goal -- pause` or `/goal -- cancel` to create a goal whose objective starts with that word
- `--max-tokens`, `--max-turns`, and `--max-minutes` are options only before the objective
- option values must be positive integers
- `--` ends option parsing and keeps the rest as the objective
- the objective must be non-empty
- the objective must be at most 4000 characters
- longer work descriptions should be referenced by file path in the objective text

Before creating or replacing a goal, `handleGoalCommand()` shall check:

- `host.state.appState.model.trim().length > 0`
- `host.session !== undefined`

If either check fails, it shall show `LLM_NOT_SET_MESSAGE` and not call `Session.createGoal()`.
This avoids creating a goal that cannot start a model turn.

For `/goal <objective>`, the handler shall:

- call `host.requireSession().createGoal({ objective, budgetLimits })`
- call `host.showStatus(...)`
- call `host.sendNormalUserInput(objective)`

It shall never send the literal `/goal ...` text after the command has been accepted.

For `/goal replace <objective>`, the handler shall pass `replace: true`.
Plain `/goal <objective>` shall reject when an active or paused goal exists.
This is the explicit replacement confirmation path.
The rejection message shall point the user to `/goal replace <objective>`.

For `/goal pause`, the handler shall:

- call `Session.pauseGoal({ actor: 'user' })`
- call `host.cancelInFlight?.()` when a turn is currently streaming
- not send normal input

For `/goal resume`, the handler shall:

- call `Session.resumeGoal({ actor: 'user' })`
- send a normal input such as `Resume the active goal.`

The resume input starts a turn if the app is idle.
Phase 4c will make the continuation loop take over after that turn starts.

For `/goal cancel`, the handler shall:

- call `Session.cancelGoal({ actor: 'user' })`
- call `host.cancelInFlight?.()` when a turn is currently streaming
- not send normal input

For `/goal clear`, the handler shall:

- call `Session.clearGoal({ actor: 'user' })`
- call `host.cancelInFlight?.()` when a turn is currently streaming
- not send normal input

For bare `/goal` and `/goal status`, the handler shall:

- call `Session.getGoal()`
- show active, paused, or terminal status
- include turn, token, time, and budget information when present
- not require a configured model
- not send normal input

Modify `apps/kimi-code/src/tui/commands/registry.ts`.
Add the `goal` command with `experimentalFlag: 'goal-command'`.
Use an availability function:

- creation and replacement are `idle-only`
- `status`, `pause`, `cancel`, and `clear` are `always`
- `resume` is `idle-only`

Modify `apps/kimi-code/src/tui/commands/dispatch.ts`.
Import `handleGoalCommand()` and call it for the `goal` built-in.
Keep the existing default branch in `handleBuiltInSlashCommand()`.

Modify `apps/kimi-code/src/tui/commands/index.ts`.
Export `handleGoalCommand()`.

## Tests

Add `apps/kimi-code/test/tui/commands/goal.test.ts`.

The tests shall cover:

- `/goal` calls `Session.getGoal()` and does not send input
- `/goal status` calls `Session.getGoal()` and does not send input
- `/goal Ship feature X` calls `Session.createGoal({ objective: 'Ship feature X' })`
- `/goal --max-tokens 50000 Ship feature X` passes `budgetLimits.tokenBudget`
- `/goal --max-turns 8 Ship feature X` passes `budgetLimits.turnBudget`
- `/goal --max-minutes 30 Ship feature X` passes `budgetLimits.wallClockBudgetMs`
- `/goal -- --max-tokens is part of the goal` treats the text after `--` as objective text
- `/goal -- cancel` creates a goal whose objective starts with `cancel`
- objectives longer than 4000 characters are rejected before SDK calls
- `/goal replace Ship feature Y` passes `replace: true`
- duplicate-goal errors from `Session.createGoal()` are surfaced through `host.showError()` with guidance to use `/goal replace`
- `/goal pause` calls `Session.pauseGoal()` and does not send input
- `/goal resume` calls `Session.resumeGoal()` and sends a resume input
- `/goal cancel` calls `Session.cancelGoal()` and does not send input
- `/goal clear` calls `Session.clearGoal()` and does not send input
- status, pause, cancel, and clear do not require a configured model when a session exists
- creation without a configured model shows `LLM_NOT_SET_MESSAGE`
- creation without an active session shows `LLM_NOT_SET_MESSAGE`
- accepted creation sends `Ship feature X`, not `/goal Ship feature X`

These tests prove parser behavior, precondition checks, host API calls, replacement semantics, status behavior, and first-turn dispatch.

Update `apps/kimi-code/test/tui/commands/registry.test.ts`.
It shall prove `goal` is registered behind `goal-command` and that availability depends on the subcommand.

Update `apps/kimi-code/test/tui/commands/resolve.test.ts`.
It shall prove:

- `/goal Ship feature X` resolves to the built-in `goal` command when `goal-command` is enabled
- `/goal Ship feature X` resolves to `{ kind: 'message', input: '/goal Ship feature X' }` when the flag is disabled
- creation is blocked while streaming
- `/goal pause`, `/goal cancel`, `/goal clear`, and `/goal status` are not blocked while streaming

Add or update SDK tests near `packages/node-sdk`.
They shall prove every public goal method forwards the right payload to `SDKRpcClient`.
They shall also prove `Session.updateGoal` is not part of the public SDK class.

## Verification

Run:

```bash
pnpm --filter @moonshot-ai/kimi-code test -- test/tui/commands/goal.test.ts test/tui/commands/registry.test.ts test/tui/commands/resolve.test.ts
pnpm --filter @moonshot-ai/kimi-code run typecheck
pnpm --filter @moonshot-ai/kimi-code-sdk run typecheck
! rg -n "@moonshot-ai/agent-core" apps/kimi-code/src
```

The final `rg` command should find no direct `@moonshot-ai/agent-core` imports in `apps/kimi-code/src`.
