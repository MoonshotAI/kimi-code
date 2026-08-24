# Bug Assessment: TodoList reminder cancels an in-flight compaction

- **Slug**: todolist-cancels-compaction
- **Created**: 2026-08-25
- **Source**: pasted text (+ follow-up clarification)
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

Pasted report (verbatim):

> while the pause goal while compaction works now, there is still some other things whgen an active Todolist runs that literally cancels the compation and it make a loading animation it is like a trigger kicks in and cancels active compaction it can be time based as well, if so increase it to 180 seconds while large context can take a while to compatct. otherwise make sure there is no process triggers or kicks in while a compatction is on process

Follow-up clarification (verbatim):

> so regardless of goal mode, when auto compaction is running everything should pause and agent can nudge a continue when auto-compaction completes

The reporter observes that the earlier fix which makes a **goal** pause while compaction runs (`goal-pause-compaction`) works, but a separate process still cancels the in-flight compaction: an **active TodoList**. When a TodoList is in use, the compaction begins (the TUI "Compacting context…" loading block appears) and is then immediately cancelled by a "trigger" that kicks in. The reporter offers two hypotheses: (a) it is a time-based watchdog and should be raised to 180s, or (b) some process fires while compaction is in progress and should be blocked. They want everything (regardless of goal mode) to pause while auto compaction runs, and to be able to continue once it completes.

## Symptom

When an active TodoList is present and auto (or manual) compaction kicks in, a TodoList reminder is injected into the conversation context *during* the compaction. The compaction service's post-round guard rejects the now-mutated history and cancels the in-flight compaction (`compaction.cancelled` fires) instead of letting it finish. The TUI shows the compaction loading block and then a "Compaction cancelled" state, and the context is never compacted.

## Reproduction

1. Have an active TodoList (TodoList tool used at least once, `used === true`) with a stale list so the periodic reminder is due (`todoListStaleReminder` returns non-`undefined`).
2. Grow the context large enough to cross the auto-compaction threshold, or trigger `/squeeze` (manual) while the list is stale.
3. Auto compaction fires from inside the turn step lifecycle (`beforeStep` → `checkAutoCompaction` → `begin({ source: 'auto' })`), or manual compaction acquires quiescence.
4. The context injector's `onWillBeginStep` hook (or `reconcileWhenIdle` during quiescence) appends the TodoList reminder to the context while the compaction LLM request is in flight.
5. When the compaction round finishes, `historySafeToCompact(current, original)` sees the appended, non-user `injection` message and returns `false` → `cancelActive` → `compaction.cancelled`.
6. [NEEDS CLARIFICATION: exact frequency — depends on the TodoList reminder cadence (`TODO_LIST_REMINDER_TURNS_SINCE_WRITE`/`TURNS_BETWEEN_REMINDERS` = 10) and on `onWillBeginStep` hook ordering vs. the compaction `beforeStep` hook.]

## Suspected Code Paths

- `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:933` — `if (!historySafeToCompact(this.context.get(), originalHistory)) { … this.cancelActive(active); throw … }`. This is the exact cancellation point: any context mutation during the round aborts the compaction.
- `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:1038` — `historySafeToCompact()` returns `false` when the current history is longer than `original` and the appended tail is not all real user input (`isRealUserInput`). A TodoList reminder (`origin.kind === 'injection'`) is **not** a real user input, so it fails the guard.
- `packages/agent-core-v2/src/agent/contextInjector/contextInjectorService.ts:42` and `:80` — `reconcileAroundStep` runs on `loopService.hooks.onWillBeginStep`, calling `inject()` → `injectEntry()` → `appendResult()` which appends the TodoList reminder to the live context (`appendSystemReminder`). For auto compaction this fires in the *same* step's before-step phase as the compaction `beforeStep` hook; for manual compaction, `reconcileWhenIdle()` (`:67`) can append during the acquired quiescence.
- `packages/agent-core-v2/src/features/todo/todoListReminder.ts:21` — `todoListStaleReminder()` returns the reminder string when a stale active TodoList is present.
- `packages/agent-core-v2/src/agent/contextMemory/compactionHandoff.ts:159` — `isRealUserInput()` returns `false` for `origin.kind === 'injection'`, confirming the reminder is treated as unsafe-to-compact.
- `packages/agent-core-v2/src/agent/prompt/promptService.ts:231` and `:404` — the **precedent** fix (`goal-pause-compaction`): the prompt service already defers launching new turns while `fullCompaction.compacting !== null && loop.status().state !== 'running'`. This blocks the *goal continuation turn* but does **not** block the *context injector* from mutating the live context, which is the TodoList cancellation path.

## Root Cause Hypothesis

The auto-compaction `beforeStep` hook (`fullCompactionService.beforeStep`) and the context-injector `onWillBeginStep` hook both run in the same step's before-step phase. When compaction begins inline (capturing `originalHistory`), the subsequent context-injector hook appends the TodoList reminder to the live context. The compaction's `historySafeToCompact` guard then sees a context that changed during the round (an `injection`-origin message appended) and cancels the round via `cancelActive`. For manual compaction, `reconcileWhenIdle`/session-start injections mutate the context during the acquired quiescence with the same result. The prompt-service compaction guard only stops *new turns*; it leaves the context injector free to mutate the context during compaction, which is exactly what cancels it.

Confidence: high. The cancellation point (`historySafeToCompact` → `cancelActive` at `fullCompactionService.ts:933`) is unambiguous, and the TodoList reminder is provably a non-user `injection` message that fails the guard. The only uncertainty is the precise hook-ordering/reproduction cadence, which does not affect the fix.

Regarding the reporter's "time based, increase to 180s" hypothesis: there is **no time-based watchdog** in the compaction code. The only timers are `sleepForRetry` between LLM retries (`fullCompactionService.ts:922`) and the 2-hour subagent timeout — none of which cancel compaction. The compaction lifetime is bounded only by the LLM request and retries, so the symptom of "compaction cancelled after a while" is explained by the injection race, not a timeout. No 180s timeout should be added; doing so would be a no-op mis-fix.

## Proposed Remediation

**Preferred**: Make the context injector compaction-aware so it does not mutate the live context while a compaction is in flight, mirroring the prompt-service guard.

1. Inject `IAgentFullCompactionService` into `AgentContextInjectorService`.
2. In `reconcileAroundStep` / `inject` (and `reconcileWhenIdle`), skip appending when `fullCompaction.compacting !== null`. Because the compaction `beforeStep` hook can run before the injector hook in the same step, also re-check after `next()` (the existing `compactionRearmPending`/`ContextSpliced` rearm already re-injects after compaction, so no reminder is lost).
3. This keeps `historySafeToCompact` honest (only genuine user input during compaction cancels it) and makes "everything pauses while auto compaction runs" true regardless of goal mode — matching the reporter's clarification.

**Alternatives**:
- Harden `historySafeToCompact` to tolerate appended messages whose `origin` is not `user` (treat `injection`/`system_trigger`/`compaction_summary`/`hook_result` tails as safe). Lighter, but it weakens the guard's intent (it exists to reject real concurrent edits) and still lets benign injections churn the context during compaction rather than pausing cleanly.
- Have `begin()`/`beginAutoCompaction()` itself acquire a hard "no-injection" lock. Couples compaction to the injector; the injector is the better owner of the rule.

**Files likely to change**:
- `packages/agent-core-v2/src/agent/contextInjector/contextInjectorService.ts` — add the `compacting` guard (primary fix, symmetric to `promptService.ts:231`/`:404`).
- `packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts` — only if choosing the `historySafeToCompact` alternative; no change needed for the preferred fix.
- `apps/kimi-code/src/tui/components/dialogs/compaction.ts` + `apps/kimi-code/src/tui/controllers/session-event-handler.ts` — optional: surface "Context compaction in progress; TodoList reminder paused" so the pause is visible (the same TUI feedback the goal fix added).

**Tests to add or update**:
- `packages/agent-core-v2/test/agent/fullCompaction/` (or `test/agent/contextInjector/`): with an active stale TodoList, start a compaction and assert (a) the context injector does **not** append a TodoList reminder while `compacting !== null`, and (b) the round reaches `compaction.completed` with exactly **zero** `compaction.cancelled`.
- A regression test that simulates a `ContextSpliced` / reminder append *during* a live compaction and asserts `historySafeToCompact` no longer cancels (or that the injector skips the append entirely).
- TUI test (`apps/kimi-code/test/tui/controllers/session-event-handler-compaction.test.ts`): assert a `compaction.started` while a TodoList is active does not surface a `compaction.cancelled`.

## Risks & Considerations

- **Hook ordering**: the fix must work whether the compaction `beforeStep` hook or the context-injector hook runs first in the same step. Guarding on `fullCompaction.compacting` inside the injector handles both (if injector runs first, the reminder is captured as part of `originalHistory` and is safe; if it runs after, it is skipped).
- **Lost reminders**: the injector already re-injects on `ContextSpliced` (compaction rear). Skipped reminders during compaction will be re-applied right after, so no reminder is dropped.
- **Both engines**: like `goal-pause-compaction`, this affects v1 (`packages/agent-core`) and v2 (`packages/agent-core-v2`). The v2 `contextInjector`/`fullCompaction` are the priority (CLI default engine); v1 parity should follow.
- **Manual vs auto**: the guard applies to both `manual` (`/squeeze`) and `auto` compaction, consistent with the reporter's "regardless of goal mode" clarification.
- **No timeout change**: do not add the suggested 180s timer — no such watchdog exists, and adding one would not address the real (process-driven) cause.

## Open Questions

- [NEEDS CLARIFICATION: is the reporter seeing this on manual (`/squeeze`) or auto compaction, or both? The fix covers both but the dominant repro matters for the test.]
- [NEEDS CLARIFICATION: should the context injector also be paused for other non-TodoList injections during compaction (e.g. plugin/session-start reminders)? The preferred fix pauses all injection uniformly, which is the conservative choice.]
