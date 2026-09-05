## Symptom

When a goal is running, the agent loop's auto-compaction fires from inside the turn step lifecycle and blocks the live goal continuation turn. Because the goal runtime is completely unaware of compaction, the goal driver keeps starting/ending continuation turns, and the in-flight compaction gets cancelled repeatedly (`compaction.cancelled` fires over and over) instead of being allowed to finish. The goal never explicitly pauses and never resumes after compaction, so it makes no progress and wastes API spend.

Expected: when auto compaction kicks in the goal should be aware of it, simply pause (with TUI feedback: "goal is paused due to compaction in progress, will resume after compaction complete"), and automatically resume once compaction finishes.

## Reproduction

1. Start a goal (`/goal <objective>`) whose work grows the context large enough to cross the auto-compaction threshold.
2. Let the goal run. The goal continuation driver enqueues continuation turn after continuation turn.
3. When the loop's `beforeStep`/context-overflow path triggers auto compaction, the compaction begins and blocks the active goal turn.
4. Observe `compaction.started` followed by `compaction.cancelled` repeatedly in the transcript/events; the goal never advances.
5. [NEEDS CLARIFICATION: exact trigger that aborts the live goal turn mid-compaction — a small reproduction harness running a goal against a model with a small context window would isolate it.]

## Suspected Code Paths

Both engines implement goal + compaction independently and neither is compaction-aware:

- `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts` — `beforeStep()` → `checkAutoCompaction()` → `begin({ source: 'auto' })` → `block(signal, turnId)`. `block()` registers `propagateBlockingAbort()` which aborts the in-flight compaction when the step signal aborts. `recoverFromContextOverflow()` is the context-overflow entry that begins auto compaction and blocks. The service never references the goal.
- `packages/agent-core-v2/src/features/goal/goalAgentRuntime.ts` — drives the goal via `launchContinuationTurn()` and `handleTurnEnded()` → `settleAbnormalTurn()` → `pauseOnInterrupt()`/`pauseActiveGoal()`. The goal runtime never subscribes to `FullCompactionBegin` / `FullCompactionComplete` / `CompactionCancelled` and never gates continuation launches on compaction state. The two subsystems are fully decoupled.
- `packages/agent-core/src/agent/compaction/full.ts` — v1 equivalent: `beforeStep()`/`block()` registers an `abort` listener on the step signal that calls `this.cancel()` when the turn aborts; `handleOverflowError()` is the v1 overflow entry.
- `packages/agent-core/src/agent/turn/index.ts:865-867` — v1 `beforeStep` hook calls `this.agent.fullCompaction.beforeStep(stepSignal)`, which can block the goal continuation turn and later cancel on step-signal abort.
- `packages/agent-core/src/agent/goal/index.ts` — v1 `GoalMode`; pauses only on explicit pause/cancel, interrupt, budget, or resume-replay. No compaction hook.

TUI feedback (where the new message would surface):

- `apps/kimi-code/src/tui/components/dialogs/compaction.ts` — `CompactionComponent` renders "Compacting context…" on `compaction.started` and "Compaction cancelled" on `compaction.cancelled`. No goal-aware copy.
- `apps/kimi-code/src/tui/controllers/session-event-handler.ts:1106` (`handleCompactionEnd`), `:1125` (`handleCompactionCancel`), `:1104` (`beginCompaction`) — compaction event handling.
- `apps/kimi-code/src/tui/components/messages/goal-panel.ts:110` (`GoalStatusMessageComponent`) — already renders a `paused` goal with its `terminalReason`; the right place to surface a compaction pause reason.

## Root Cause Hypothesis

The goal runtime and the auto-compaction service are fully decoupled. Auto-compaction is triggered from within the agent loop's step lifecycle and, when it fires, **blocks** the currently-running goal continuation turn. In v2 `block()` listens for the step signal to abort (`propagateBlockingAbort`) and aborts the compaction when the step is aborted; in v1 `FullCompaction.block()` does the same via an `abort` listener that calls `cancel()`. Because a running goal is a continuous chain of continuation turns, the live goal turn is frequently torn down (a new continuation is launched, a wall-clock/budget deadline cancels the live turn, or the context-overflow recovery path re-enters and re-blocks), which aborts the in-flight compaction's step signal → `compaction.cancelled`. The goal then enqueues another continuation, re-crosses the threshold, re-triggers compaction, and the cycle repeats.

Confidence: medium. The decoupling is certain from the code; the exact recurring abort trigger (which goal-turn-teardown path fires the step-signal abort while compaction is in flight) should be confirmed with a reproduction harness, but the fix is correct regardless of which specific path aborts the turn.

## Proposed Remediation (summary)

Make the goal runtime compaction-aware:

1. On an `auto` compaction begin while the goal is `active`, transition the goal to `paused` with a dedicated reason ("Paused due to context compaction; will resume after compaction completes") and stop launching new continuation turns until compaction finishes.
2. Ensure the goal pause does not abort the active turn's step signal in a way that propagates to the compaction abort listener — the compaction should run to completion uninterrupted.
3. On `compaction.completed`, if the goal was paused for compaction, re-activate it and relaunch the continuation turn (reuse the existing `resumeGoal()` path).
4. TUI: surface the reason via the existing `goal.updated` (paused + reason) path and enhance `CompactionComponent`/`handleCompactionBegin` to show "Compacting context… (goal paused, will resume when done)".

Add a `GOAL_COMPACTION_PAUSE_REASON` constant to each engine's goal runtime. Fix both v1 (`agent-core`) and v2 (`agent-core-v2`); CLI defaults to v2 but v1 parity matters for the legacy flag.

## Severity

medium

## Open Questions

- [NEEDS CLARIFICATION: which exact goal-turn-teardown path aborts the live step signal mid-compaction — a reproduction harness with a small context window would pin this down, though it is not required for the fix.]
- [NEEDS CLARIFICATION: should the feature also pause the goal during *manual* (`/squeeze`) compaction, or only auto compaction? The reporter's wording implies auto only; recommend auto-only to start.]

---

Assessment: .specify/bugs/goal-pause-compaction/assessment.md
