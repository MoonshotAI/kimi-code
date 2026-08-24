# Bug Fix: TodoList reminder cancels an in-flight compaction

- **Slug**: todolist-cancels-compaction
- **Fixed**: 2026-08-25
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Made the context injector compaction-aware so it does not append reminder injections (e.g. the TodoList stale-list reminder) into the live context while a compaction is in flight. Previously, the injected `injection`-origin message mutated the context during the compaction round, so `historySafeToCompact` rejected the history and `cancelActive` cancelled the compaction. This is the TodoList analog of the already-fixed `goal-pause-compaction` bug and satisfies the "everything pauses while auto compaction runs" invariant regardless of goal mode.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `packages/agent-core-v2/src/agent/contextInjector/contextInjectorService.ts` | modified | Inject `IInstantiationService`; lazily resolve `IAgentFullCompactionService`; skip `inject()` (the `onWillBeginStep` path) and `reconcileWhenIdle()` while `fullCompaction.compacting !== null`. Mirrors the existing guard in `promptService.ts`. |
| `packages/agent-core-v2/test/agent/contextInjector/contextInjector.test.ts` | added test | Registers a compaction stub with a togglable `compacting` flag and asserts the injector appends nothing while a compaction is in flight, then resumes normally once it clears. |

## Diff Highlights

```ts
// AgentContextInjectorService
private fullCompactionService: IAgentFullCompactionService | undefined;

constructor(
  …,
  @IInstantiationService private readonly instantiation: IInstantiationService,
) { … }

private get fullCompaction(): IAgentFullCompactionService {
  if (this.fullCompactionService === undefined) {
    this.fullCompactionService = this.instantiation.invokeFunction((accessor) =>
      accessor.get(IAgentFullCompactionService),
    );
  }
  return this.fullCompactionService;
}

private async inject(isNewTurn: boolean): Promise<void> {
  if (this.fullCompaction.compacting !== null) return;   // skip while compacting
  for (const entry of this.entries) {
    await this.injectEntry(entry, isNewTurn);
  }
}
```

## Tests Added or Updated

- `packages/agent-core-v2/test/agent/contextInjector/contextInjector.test.ts::'does not append reminders while a compaction is in flight, then resumes after'` — pins that a registered provider is not invoked and no message is appended while `compacting` is set, and that it runs normally once cleared.

## Local Verification

- `pnpm vitest run test/agent/contextInjector/contextInjector.test.ts` → 21 passed (incl. new regression test).
- `pnpm typecheck` (agent-core-v2) → clean.
- `pnpm vitest run test/agent/fullCompaction/fullCompaction.test.ts` → 76 passed, 1 failed. The single failure (`compacts provider overflow when model context size is unknown`, asserting `compactionMaxCompletionTokens === 32000` but receiving `131072`) is **pre-existing and unrelated**: it reproduces identically on the baseline without this change (confirmed by stashing the fix). It concerns overflow max-completion-token calculation, not the injector.

## Deviations from Assessment

- The assessment listed a potential secondary hardening of `historySafeToCompact` to tolerate non-user appended messages. Not pursued — the preferred fix (pausing the injector during compaction) is sufficient and keeps `historySafeToCompact` honest (genuine concurrent user edits still correctly cancel compaction). No 180s timeout was added, because the investigation confirmed there is no time-based watchdog in the compaction code; the cancellation is process-driven.
- TUI feedback ("TodoList reminder paused during compaction") was noted as optional in the assessment and is left as a follow-up to keep the change minimal.

## Follow-ups

- Optional TUI copy in `apps/kimi-code/src/tui/components/dialogs/compaction.ts` / `session-event-handler.ts` surfacing that background injections were paused during compaction (the same kind of feedback the goal fix added).
- v1 (`packages/agent-core`) parity: `agent-core` has its own context-injection path and would need the equivalent guard if v1 compaction is still exercised.
- Investigate the unrelated pre-existing `compactionMaxCompletionTokens` (32000 vs 131072) fullCompaction test failure separately.
