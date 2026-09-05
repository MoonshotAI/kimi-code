# Bug Assessment: Auto-compaction should freeze everything (goals, todolist, auto, yolo, etc.) — past fixes cancelled compaction instead

- **Slug**: auto-compaction-freeze-all
- **Created**: 2025-08-26T08:00:02.053Z
- **Source**: pasted text (referencing past failed attempts)
- **Verdict**: valid
- **Severity**: critical

## Report (verbatim or summarized)

> create a new issue referencing past failed attempts of auto compact. when auto compact kicks in, everything should freeze, pause, goal,todolist,auoto,yolo whatever, currently when auto-compact kickis in it is just getting cancelled by agent ALL THE TIME. we did some several attempts to fix and failed, all previous code was removed so new task will get a clean slate. this should be fixed with a minimal change, preferablly a single setting, trying to toucch multiple surfaces will make it only fragile so DO NOT over engineer it, I am sure in the all configs arsenal, this can be fixed without wrintrg a single line of code only changing a setting or simply adding a 1 or 2 if statenments.

**Past failed attempts (assessments exist):**
1. `.specify/bugs/goal-pause-compaction/` — Goal runtime was supposed to pause on auto-compaction begin and resume on complete. **Failed** — compaction still cancelled.
2. `.specify/bugs/todolist-cancels-compaction/` — Context injector was supposed to skip injections during compaction. **Failed** — compaction still cancelled.

Both assessments were written, but the fixes either weren't applied or didn't work. All previous code changes were reverted/removed.

## Symptom

When auto-compaction triggers (context crosses threshold), the compaction begins but is **repeatedly cancelled** by the agent's ongoing activity (goals, todolist reminders, auto-continuation turns, etc.). The TUI shows "Compacting context…" then immediately "Compaction cancelled". The context never gets compacted, leading to context overflow and degraded performance.

The user wants **everything to freeze** when auto-compaction runs: goals pause, todolist pauses, auto/yolo modes pause — and only resume after compaction **completes successfully**.

## Reproduction

1. Run a session with auto-compaction enabled (default)
2. Grow context to cross the auto-compaction threshold (or set a low threshold for testing)
3. Have an active goal (`/goal ...`) AND/OR an active TodoList
4. Let auto-compaction trigger
5. Observe: `compaction.started` → `compaction.cancelled` (repeatedly); context never compacted

## Suspected Code Paths

**Compaction core (v2):**
- `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts` — `beforeStep()` → `checkAutoCompaction()` → `begin({ source: 'auto' })` → `block(signal, turnId)` (line ~614). The `block()` method registers `propagateBlockingAbort()` which aborts compaction when the step signal aborts. This is the **cancellation mechanism**.

**Goal subsystem (v2):**
- `packages/agent-core-v2/src/features/goal/goalAgentRuntime.ts` — Drives goal via `launchContinuationTurn()` / `handleTurnEnded()`. Previous fix attempted to subscribe to `FullCompactionBegin`/`FullCompactionComplete` and pause/resume, but didn't prevent the step signal abort that cancels compaction.

**TodoList subsystem (v2):**
- `packages/agent-core-v2/src/agent/contextInjector/contextInjectorService.ts` — `reconcileAroundStep` on `onWillBeginStep` hook injects TodoList reminders during compaction.
- `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:933` — `historySafeToCompact()` rejects context mutated by injections → `cancelActive()` → `compaction.cancelled`.

**Prompt service (v2):**
- `packages/agent-core-v2/src/agent/prompt/promptService.ts:231,404` — Already has `fullCompaction.compacting !== null` guard to defer new turns, but this doesn't stop context injector or step signal abort.

## Root Cause Hypothesis

**Confidence: high**

The root cause is architectural: **the compaction `block()` method uses the step's abort signal to cancel compaction**. Any agent turn that starts during compaction and then gets aborted (new continuation, budget deadline, user interrupt, etc.) fires the step signal abort → compaction cancelled.

The previous fixes tried to **pause higher-level systems** (goal, todolist) but didn't address the **core mechanism**: the step signal abort propagates to compaction. As long as the agent loop can start a turn during compaction and that turn can be aborted, compaction will be cancelled.

The user's insight: **"in the all configs arsenal, this can be fixed without writing a single line of code only changing a setting or simply adding a 1 or 2 if statements"** — suggests there's a configuration flag or simple guard that prevents turn starts during compaction, rather than trying to coordinate pause/resume across multiple subsystems.

## Proposed Remediation

**Preferred**: **Single config flag / minimal guard** to prevent *any* turn from starting while compaction is in flight, rather than coordinating pause/resume across goals/todolist/auto/yolo.

Looking at the code:
- `promptService.ts` already checks `fullCompaction.compacting !== null` to defer turns
- But the **loop itself** still runs steps during compaction (the compaction runs *inside* a blocked step)
- The issue is that **other code paths** (context injector hooks, goal continuation logic) can trigger during the blocked step

**Minimal fix candidates (config-only or 1-2 if statements):**
1. **Add a `compaction.exclusive` config flag** (default `true`) that makes the loop skip `beforeStep`/`onWillBeginStep` hooks entirely while compaction is running
2. **Extend the existing `promptService` guard** to also gate the context injector and any other hook that can mutate context/start turns
3. **Set a global "compaction in progress" flag on the session/agent** that all subsystems check before doing anything

The user believes this is solvable via **configuration**. Check if there's already a flag like `compaction.blocksAllActivity` or similar in the config schema.

**Files likely to change (minimal):**
- `packages/agent-core-v2/src/agent/fullCompaction/configSection.ts` — add config flag if missing
- `packages/agent-core-v2/src/agent/loop/loop.ts` — single `if (compacting) return` in step entry
- OR `packages/agent-core-v2/src/agent/prompt/promptService.ts` — extend existing guard (already has the pattern)

**Tests to add or update:**
- Test that with the config enabled, auto-compaction runs to completion without any `compaction.cancelled` when goals/todolist/auto are active
- Test that the compaction completes in one go (no repeated start/cancel cycles)

## Risks & Considerations

- **Minimalism**: User explicitly said "DO NOT over engineer it", "single setting", "1 or 2 if statements". Any fix touching multiple files/subsystems is wrong.
- **Clean slate**: All previous code was removed. This is a fresh attempt.
- **Config-driven**: The fix should ideally be a config change, not code. If code is needed, it must be a single guard in the main loop.

## Open Questions

- [NEEDS CLARIFICATION: Is there already a config flag for this in `fullCompaction` config section?]
- [NEEDS CLARIFICATION: Which engine — v1 (`agent-core`) or v2 (`agent-core-v2`) — is the CLI using? The fix should target the default engine.]
- [NEEDS CLARIFICATION: Should manual compaction (`/squeeze`) also get exclusive mode, or only auto?]