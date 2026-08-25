# Bug Assessment: Goal paused/paused-compaction — goal should pause and auto-resume around auto compaction

- **Slug**: goal-pause-compaction
- **Created**: 2026-08-24
- **Source**: pasted text
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

> when a goal is running auto compaction gets cancelled repeatedly, when auto compaction kicks in goal should be aware of it and simply pause and after compaction resume the goal automatically. it would be nice to give feedback on TUI, goal is paused due to compaction in progress, will resume after compaction complete

The reporter observes that an actively-running goal triggers auto compaction, but instead of the goal pausing and resuming after the compaction finishes, the compaction is repeatedly cancelled. Desired behavior: the goal should be compaction-aware — pause when auto compaction starts (with a TUI message), and automatically resume once compaction completes.

## Symptom

When a goal is running, the agent loop's auto-compaction fires from inside the turn step lifecycle and blocks the live goal continuation turn. Because the goal runtime is completely unaware of compaction, the goal driver keeps starting/ending continuation turns, and the in-flight compaction gets cancelled repeatedly (`compaction.cancelled` fires over and over) instead of being allowed to finish. The goal never explicitly pauses and never resumes after compaction, so it makes no progress and wastes API spend.

## Reproduction

1. Start a goal (`/goal <objective>`) whose work grows the context large enough to cross the auto-compaction threshold.
2. Let the goal run. The goal continuation driver enqueues continuation turn after continuation turn.
3. When the loop's `beforeStep`/context-overflow path triggers auto compaction, the compaction begins and blocks the active goal turn.
4. Observe `compaction.started` followed by `compaction.cancelled` repeatedly in the transcript/events; the goal never advances.
5. [NEEDS CLARIFICATION: exact trigger that aborts the live goal turn mid-compaction — see Root Cause Hypothesis. A small reproduction harness that runs a goal against a model with a small context window would isolate it.]

## Suspected Code Paths

Both engines implement goal + compaction independently and neither is compaction-aware:

- `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts` — `beforeStep()` → `checkAutoCompaction()` → `begin({ source: 'auto' })` → `block(signal, turnId)`. `block()` registers `propagateBlockingAbort()` (line ~614) which aborts the in-flight compaction when the step signal aborts. `recoverFromContextOverflow()` (line ~527) is the context-overflow entry that begins auto compaction and blocks. The service never references the goal.
- `packages/agent-core-v2/src/features/goal/goalAgentRuntime.ts` — drives the goal via `launchContinuationTurn()` (line ~761) and `handleTurnEnded()` (line ~658) → `settleAbnormalTurn()` (line ~719) → `pauseOnInterrupt()`/`pauseActiveGoal()`. The goal runtime never subscribes to `FullCompactionBegin` / `FullCompactionComplete` / `CompactionCancelled` and never gates continuation launches on compaction state. The two subsystems are fully decoupled.
- `packages/agent-core/src/agent/compaction/full.ts` — v1 equivalent: `beforeStep()`/`block()` (line ~317) registers an `abort` listener on the step signal that calls `this.cancel()` when the turn aborts; `handleOverflowError()` (line ~256) is the v1 overflow entry.
- `packages/agent-core/src/agent/turn/index.ts:865-867` — v1 `beforeStep` hook calls `this.agent.fullCompaction.beforeStep(stepSignal)`, which can block the goal continuation turn and later cancel on step-signal abort.
- `packages/agent-core/src/agent/goal/index.ts` — v1 `GoalMode`; pauses only on explicit pause/cancel, interrupt, budget, or resume-replay (`normalizeAfterReplay`). No compaction hook.

TUI feedback (where the new message would surface):

- `apps/kimi-code/src/tui/components/dialogs/compaction.ts` — `CompactionComponent` renders "Compacting context…" on `compaction.started` and "Compaction cancelled" on `compaction.cancelled`. No goal-aware copy.
- `apps/kimi-code/src/tui/controllers/session-event-handler.ts:1106` (`handleCompactionEnd`), `:1125` (`handleCompactionCancel`), `:1104` (`beginCompaction`) — compaction event handling on the TUI side.
- `apps/kimi-code/src/tui/components/messages/goal-panel.ts:110` (`GoalStatusMessageComponent`) — already renders a `paused` goal with its `terminalReason`; the right place to surface a compaction pause reason.

## Root Cause Hypothesis

The goal runtime and the auto-compaction service are fully decoupled. Auto-compaction is triggered from within the agent loop's step lifecycle and, when it fires, **blocks** the currently-running goal continuation turn. In v2 `block()` listens for the step signal to abort (`propagateBlockingAbort`) and aborts the compaction when the step is aborted; in v1 `FullCompaction.block()` does the same via an `abort` listener that calls `cancel()`. Because a running goal is a continuous chain of continuation turns, the live goal turn is frequently torn down (a new continuation is launched, a wall-clock/budget deadline cancels the live turn, or the context-overflow recovery path re-enters and re-blocks), which aborts the in-flight compaction's step signal → `compaction.cancelled`. The goal then enqueues another continuation, re-crosses the threshold, re-triggers compaction, and the cycle repeats.

Confidence: medium. The decoupling is certain from the code; the exact recurring abort trigger (which goal-turn-teardown path fires the step-signal abort while compaction is in flight) should be confirmed with a reproduction harness, but the fix below is correct regardless of which specific path aborts the turn.

## Proposed Remediation

**Preferred**: Make the goal runtime compaction-aware so the goal pauses explicitly when auto compaction begins and auto-resumes when it completes, and so compaction is never aborted by the goal's turn churn.

1. **Pause on compaction begin.** When an `auto` compaction begins while the goal is `active`, transition the goal to `paused` with a dedicated reason such as `"Paused due to context compaction; will resume after compaction completes"`, and stop the goal from enqueuing new continuation turns until compaction finishes. This prevents the goal from re-triggering and keeps the live turn from being aborted mid-compaction.
2. **Do not let the goal abort the in-flight compaction.** Ensure the goal pause does not cancel the active turn's step signal in a way that propagates to the compaction abort listener; the compaction should run to completion uninterrupted.
3. **Auto-resume on compaction complete.** On `compaction.completed` (v2 `FullCompactionComplete` / `compaction.completed`; v1 `compaction.completed`), if the goal was paused for compaction, re-activate it and relaunch the continuation turn (the same resume path `resumeGoal()` already uses), so the goal continues without user action.
4. **TUI feedback.** Surface the reason via the existing `goal.updated` (kind `lifecycle`, status `paused`, reason) path rendered by `goal-panel.ts`, and enhance `CompactionComponent`/`handleCompactionBegin` to show something like: "Compacting context… (goal paused, will resume when done)".

Add a `GOAL_COMPACTION_PAUSE_REASON` constant to each engine's goal runtime (mirroring the existing `GOAL_RATE_LIMIT_PAUSE_REASON` etc.).

**Alternatives**:
- Block continuation launches whenever `fullCompaction.compacting` is true (a lighter touch: gate `launchContinuationTurn` on compaction state) and resume after `compaction.completed`, without the explicit "paused" status. Simpler, but loses the TUI clarity the reporter wants and leaves the goal status misleading (`active` while nothing is happening).
- Have the loop's auto-compaction path itself pause the goal before blocking. Couples compaction to goals; the goal runtime is the better owner of the rule since it already owns pause/resume.

**Files likely to change**:
- `packages/agent-core-v2/src/features/goal/goalAgentRuntime.ts` — subscribe to `FullCompactionBegin`/`FullCompactionComplete`/`CompactionCancelled` via the event bus/dispatcher; add `GOAL_COMPACTION_PAUSE_REASON`; gate `launchContinuationTurn`; auto-resume on completion.
- `packages/agent-core-v2/src/agent/fullCompaction/compactionOps.ts` — no change needed (events already exist: `FullCompactionBegin`, `FullCompactionComplete`, `CompactionCancelled`).
- `packages/agent-core/src/agent/goal/index.ts` — `GoalMode`: add compaction pause reason; add hooks to pause on compaction begin and resume on complete (or expose a method the turn/loop layer calls).
- `packages/agent-core/src/agent/turn/index.ts` — gate goal continuation launch while `fullCompaction.isCompacting`; relay auto-compaction events to the goal.
- `apps/kimi-code/src/tui/components/dialogs/compaction.ts` + `apps/kimi-code/src/tui/controllers/session-event-handler.ts` — goal-aware compaction copy.
- `apps/kimi-code/src/tui/components/messages/goal-panel.ts` — already renders paused+reason; verify the new reason reads well.

**Tests to add or update**:
- v2 (`packages/agent-core-v2/test/agent/fullCompaction/` or `features/goal/`): with an active goal, trigger auto compaction (overflow or threshold) and assert the goal transitions to `paused` with the compaction reason, that exactly one `compaction.completed` is emitted and **no** `compaction.cancelled`, and that on completion the goal resumes and relaunches a continuation turn.
- v1 parity test in `packages/agent-core/test/agent/compaction/` or `goal/`.
- TUI test (`apps/kimi-code/test/tui/controllers/session-event-handler-compaction.test.ts`): assert a `compaction.started` emitted while a goal is active surfaces the "paused, will resume" message.

## Risks & Considerations

- **Avoid double-pause / resume loops**: the compaction pause must not race with normal pause/resume (user `/goal pause`) or with budget/interrupt pauses — tag the pause reason so only the compaction pause auto-resumes.
- **Replay correctness**: goal pause/resume are durable events; ensure the new compaction-pause events replay cleanly on agent resume (a `paused` goal after replay is already the expected state and needs no special handling, unlike `active`).
- **Both engines**: the bug exists in v1 (`agent-core`) and v2 (`agent-core-v2`); fixing only one leaves the other engine broken. The CLI defaults to agent-core-v2 (`apps/kimi-code/src/cli/run-shell.ts`), so v2 is the higher-priority fix, but v1 parity matters for the legacy flag.
- **API/contract**: no external API change; the new pause reason is internal text. `goal.updated` already carries `terminalReason`, so no protocol change is needed for the TUI.
- **Observability**: track a telemetry event (e.g. `goal_paused_for_compaction`) so the cancellation pattern can be measured before/after the fix.

## Open Questions

- [NEEDS CLARIFICATION: which exact goal-turn-teardown path aborts the live step signal mid-compaction — a reproduction harness with a small context window would pin this down, though it is not required for the fix.]
- [NEEDS CLARIFICATION: should the feature also pause the goal during *manual* (`/squeeze`) compaction, or only auto compaction? The reporter's wording implies auto only; recommend auto-only to start.]
