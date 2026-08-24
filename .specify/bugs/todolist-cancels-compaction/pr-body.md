## Summary

Make the context injector compaction-aware so it does not append reminder injections (e.g. the TodoList stale-list reminder) into the live context while a compaction is in flight. Previously the injected `injection`-origin message mutated the context during the compaction round, so `historySafeToCompact` rejected the history and `cancelActive` cancelled the compaction. This is the TodoList analog of the already-fixed `goal-pause-compaction` bug and satisfies the "everything pauses while auto compaction runs" invariant regardless of goal mode.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `packages/agent-core-v2/src/agent/contextInjector/contextInjectorService.ts` | modified | Inject `IInstantiationService`; lazily resolve `IAgentFullCompactionService`; skip `inject()` (the `onWillBeginStep` path) and `reconcileWhenIdle()` while `fullCompaction.compacting !== null`. Mirrors the existing guard in `promptService.ts`. |
| `packages/agent-core-v2/test/agent/contextInjector/contextInjector.test.ts` | added test | Registers a compaction stub with a togglable `compacting` flag and asserts the injector appends nothing while a compaction is in flight, then resumes normally once it clears. |

## Verification

- `pnpm vitest run test/agent/contextInjector/contextInjector.test.ts` → 21 passed (incl. new regression test).
- `pnpm typecheck` (agent-core-v2) → clean.
- `pnpm vitest run test/agent/fullCompaction/fullCompaction.test.ts` → 76 passed, 1 failed. The single failure (`compacts provider overflow when model context size is unknown`) is pre-existing and unrelated: it reproduces identically on the baseline without this change.

Assessment: .specify/bugs/todolist-cancels-compaction/assessment.md
