# `/goal` Implementation Tracker

High-level goal: implement the `/goal` command (autonomous goal mode) in the kimi-code
coding agent, following the phase plans in this directory.

## Status legend

- ⬜ Not started
- 🟡 In progress
- ✅ Complete

## Phases

| Phase | Title | Status | Commit |
|-------|-------|--------|--------|
| 1a | Core session goal state | ✅ | 040a06c |
| 1b | Goal audit and resume lifecycle | ✅ | 70ee3c6 |
| 2  | SDK API and `/goal` command surface | ✅ | c14b025 |
| 3  | Model goal tools | ✅ | c5d8a90 |
| 4a | Goal context injection | ✅ | 687654c |
| 4b | Goal usage accounting | ✅ | aea58a5 |
| 4c | Goal continuation loop | ✅ | 0899188 |
| 4d | Goal evaluator | ✅ | d0dc822 |
| 5  | End-to-end integration and gates | ✅ | (this commit) |
| 6  | Headless goal mode and hardening | 🟡 | — |

## Detours / Notes

(None yet.)

## Log

- Phase 1a complete: `SessionGoalStore` (`session/goal.ts`) owns durable goal state in
  `metadata.custom.goal`; `Session`/`Agent` wired with the store; goal error codes added;
  `updateSessionMetadata` reserves `custom.goal`. 33 goal tests pass; typecheck clean; no
  agent-core imports in app src.

### Detour notes (Phase 1a)

- `createGoal` accepts an optional `actor` (default `'user'`) so both the user path and the
  Phase 3 model `CreateGoal` tool can set `startedBy`/`updatedBy`. Plan signature unchanged
  otherwise.
- `recordEvaluatorVerdict` is implemented in 1a (state side); the consecutive-failure increment
  path is deferred to Phase 4d (recordEvaluatorVerdict resets failures on a produced verdict).
- Audit records (`goal.*` wire entries) are intentionally NOT wired in 1a — that is Phase 1b.

### Phase 1b

- Added 7 `goal.*` wire record types; replay ignores them (state is from `state.json`).
- `SessionGoalStore` gained lazy `auditSink`, pending queue, `flushPendingRecords()`,
  `normalizeMetadata()`; every mutating method now appends its audit record.
- Session flushes pending goal records after the main agent exists (createMain + resume) and
  runs `normalizeMetadata()` after `readMetadata()` on resume (active → paused).
- `goal.account_usage` uses `usageKind: 'token' | 'wall_clock'`. 62 goal/records tests pass;
  full agent-core suite (2281) green; typecheck clean.

### Phase 2

- Added `goal-command` experimental flag (`KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND`, default off).
- `SessionAPI`/`CoreAPI` gained session-scoped `createGoal`/`getGoal`/`pauseGoal`/`resumeGoal`/
  `cancelGoal`/`clearGoal` (sessionId only, no agentId); core-api re-exports goal value types;
  `SessionAPIImpl` + `CoreImpl` delegate to `session.goals`.
- node-sdk: re-exported goal types; `SDKRpcClient` + `Session` forwarding methods (no public
  `updateGoal`).
- App: new `commands/goal.ts` deterministic parser + `handleGoalCommand`; registered behind
  `goal-command` with subcommand-aware availability; wired into dispatch/index.
- Tests: goal.test.ts (44 w/ registry+resolve), session-goal.test.ts (7). All typechecks pass;
  still no agent-core imports in app src.

### Detour note (Phase 2)

- The plan's SDK test direction ("forwards the right payload to SDKRpcClient") is implemented as a
  focused `Session`-with-stub-rpc unit test rather than a full harness round-trip, which is faster
  and directly asserts payload shape. Full end-to-end dispatch is covered in Phase 5.

### Phase 3

- Added `CreateGoalTool`/`GetGoalTool`/`UpdateGoalTool` under `tools/builtin/goal/` with `.md`
  descriptions and a shared main-agent/store guard. `UpdateGoal` records a model report (no
  direct terminal change). Errors converted to `isError` results with the typed code.
- `ToolManager.initializeBuiltinTools()` registers the three only when
  `flags.enabled('goal-command')` and `agent.type === 'main'`; profile `agent.yaml` lists them
  (subagent profiles do not).
- Tests: tools/goal.test.ts (registration gate via flag env + tool behavior), profile test.
  Full agent-core suite (2300) green; typecheck clean.

### Phase 4a

- Added `GoalInjector` (`agent/injection/goal.ts`, variant `goal`): injects only for an active
  goal (none/paused/terminal → no injection), wraps objective in `<untrusted_objective>` and
  completion criterion in `<untrusted_completion_criterion>`, shows status/progress/budgets with
  three threshold bands (<75% / 75–99% / ≥100%), plus model-report and evaluator context.
- `InjectionManager` adds it (after PluginSessionStart, before PlanMode) only when
  `goal-command` enabled and `agent.type === 'main'`, via an explicit push-ordered array.
- Test harness `testAgent` gained a `goals` option. Tests: injection/goal.test.ts (14) including
  the wire `context.append_message` record with `origin.variant === 'goal'`. Injection suite (33)
  green; typecheck clean.

### Phase 4b

- `TurnFlow` `afterStep` now records goal token usage (`grandTotal(usage)`, source `agent_step`,
  agent id derived from homedir basename) for every session agent step when an active goal exists.
  Comment `// Goal token budgets count every session agent step.` added.
- Token accounting is not flag-gated (a goal only exists via flag-gated paths anyway); the store's
  `recordTokenUsage` already no-ops for paused/terminal goals and writes no audit record then.
- Wall-clock accounting stays store-side (`recordWallClockUsage`); per the plan, the live
  per-continuation wall-clock recording + final-interval finalize hook land in Phase 4c.
- Tests added to turn.test.ts (42 pass): main + subagent token accounting, no-active-goal skip,
  token budget flag update without status change, paused skip, terminal-not-cleared, store
  wall-clock accumulation.

### Detour note (Phase 4b)

- The 4b plan also lists "subagent wall-clock does not update wallClockMs" and "superseded turn
  does not update final wall-clock". Those depend on the Phase 4c continuation controller /
  finalize hook (the only wall-clock writers from turns), so they are covered in Phase 4c, not 4b.

### Phase 4c

- Added `GoalContinuationController` (`agent/goal/continuation.ts`): per-turn state, injected
  clock, `lastWallClockAccountedAt` checkpoint; gated on flag + main + active goal. Decision
  order: stop if gone/paused/terminal → incrementTurn → record wall-clock → accept model report
  (complete/blocked/impossible) → hard-budget wrap-up → `maxStepsPerTurn` reconciliation →
  continue. Continuation/wrap-up prompts use `origin {kind:'system_trigger', name:'goal_continuation'}`.
  `markBudgetLimited` makes the goal terminal so the single wrap-up runs exactly once.
- `TurnFlow`: passes `startedAt` into the private `runTurn`, constructs the controller once,
  wraps the loop in `finally` to `finalizeWallClock()` (guarded by flag+main+turnId-owned+same
  goal). `shouldContinueAfterStop` order is now flush → external Stop hook (one continuation,
  uncapped for goals) → goal controller. Abnormal ends mark the active goal: aborted →
  `interrupted` (handled both on the normal `'aborted'` return and in the catch), failure →
  `error`, escaped `MaxStepsExceeded` → `budget_limited`. All main-agent + flag gated.
- Tests: goal-continuation.test.ts (20) — controller unit decisions + harness integration
  (auto-continue, subagent/flag-off no-continue, maxSteps→budget_limited, fail→error,
  cancel→interrupted, Stop-hook interplay). Full agent-core suite (2334) green; typecheck clean.

### Phase 4d

- Added `GoalEvaluator` (`agent/goal/evaluator.ts`): no-tool judge over a bounded conversation
  slice; strict-JSON verdict (`continue`/`complete`/`blocked`/`impossible`/`no_progress`) with
  balanced-brace JSON extraction; returns typed result + `usage`; typed error on bad JSON or a
  thrown call. Constructor seam (`{ llm }`) for a future lightweight judge.
- `GoalContinuationController` now runs the evaluator after the pre-eval budget check: counts
  evaluator tokens (`source: 'goal_evaluator'`), records the verdict, ends the goal on
  complete/blocked/impossible, re-checks budgets, enforces `noProgressTurnLimit` (→ blocked) and
  `failureTurnLimit` (→ error). The model self-report is now evidence for the evaluator, not a
  direct terminal signal.
- Store: added `recordEvaluatorFailure` (increments `consecutiveFailureTurns`, appends a
  `goal.evaluate` record with verdict `error`) — the Phase 1a deferred failure-increment path.
- Added `Agent.goalEvaluatorFactory` seam (threaded through `TurnFlow` and the test harness) so
  tests inject a fake judge deterministically.
- Tests: goal-evaluator.test.ts (24) — evaluator parsing/usage/errors + controller verdict
  behavior incl. two-step decide; updated goal-continuation.test.ts to inject fakes where the
  path now reaches the evaluator. Full agent-core suite (2351) green; typecheck clean.

### Detour note (Phase 4d)

- Added `recordEvaluatorFailure` to the store (not in the Phase 1a method list) to carry the
  consecutive-failure increment that 4d's `failureTurnLimit` needs; flagged in the Phase 1a notes.
- Added the `Agent.goalEvaluatorFactory` injection seam (production-default undefined → real
  `GoalEvaluator`) so harness integration tests don't have to interleave evaluator JSON into the
  scripted-model queue. This matches the plan's "constructor seam for a future judge model".

### Phase 5

- Added `test/harness/goal-session.test.ts` (4): full core flow on a real `Session` +
  `SessionAPIImpl` with a scripted model and a `vi.mock`'d evaluator — proves injection reaches
  the model, token accounting runs, `UpdateGoal` records a report without ending the goal, the
  evaluator confirms completion, terminal state persists in `state.json`, and
  `agents/main/wire.jsonl` carries goal.create/account_usage/continuation/report/evaluate/update.
  Plus turn-budget wrap-up, resume (active→paused), and user lifecycle controls.
- Added an app dispatch-level integration test: `dispatchInput(host, '/goal Ship feature X')`
  routes through the real resolver, creates the goal, and sends `Ship feature X` (not the raw
  command); flag-off routes it as a normal message.
- Export review: `SessionGoalStore`/`SessionGoalState`/`GoalContinuationController`/`GoalEvaluator`
  and `goal.*` payload types stay internal; only the public goal value types are re-exported
  (via core-api → agent-core index → node-sdk types); no public `Session.updateGoal`.
- Documented `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND` (default off) + the master switch in
  `docs/en/configuration/env-vars.md`.
- Gates: full agent-core suite (2355) + app command suite (50) green; `pnpm run typecheck` OK
  across all packages; `pnpm run lint` OK (fixed an `eqeqeq` error introduced in 4b's accounting
  guard; remaining warnings are pre-existing repo-wide).

### Detour note (Phase 5)

- The plan's centerpiece harness test was built directly on the `Session` class (as `init.test.ts`
  does) with a scripted `generate`, rather than the full CoreAPI/RPC `createTestRpc` harness, and
  the evaluator is `vi.mock`'d so verdicts are deterministic without interleaving evaluator JSON
  into the model queue. This keeps the e2e flow readable and stable.
