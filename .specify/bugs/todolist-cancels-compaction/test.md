# Bug Verification: TodoList reminder cancels an in-flight compaction

- **Slug**: todolist-cancels-compaction
- **Tested**: 2026-08-25
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: verified

## Summary

The fix closes the root cause: the context injector no longer appends reminder injections (e.g. the TodoList stale-list reminder) while a compaction is in flight, so `historySafeToCompact` no longer rejects the mutated history and cancels the compaction. The mechanism-level reproduction (injector must skip while `compacting`) passes, and the broader compaction regression suite is green apart from one pre-existing, unrelated failure.

## Checks Performed

| Check | Command / Action | Result | Notes |
|-------|------------------|--------|-------|
| Mechanism reproduction (post-fix) | `test/agent/contextInjector/contextInjector.test.ts` (new test: does not append reminders while a compaction is in flight, then resumes after) | pass | Directly exercises the exact cancellation path — provider not invoked and no message appended while `compacting` is set; resumes after. |
| New / updated tests | `pnpm vitest run test/agent/contextInjector/contextInjector.test.ts` | pass | 21 passed (including the new regression test). |
| Regression suite | `pnpm vitest run test/agent/fullCompaction/fullCompaction.test.ts` | pass (1 unrelated fail) | 76 passed; 1 failed = `compacts provider overflow when model context size is unknown` (asserts `compactionMaxCompletionTokens === 32000`, got `131072`). Confirmed pre-existing: reproduces identically on the baseline without this fix. |
| Static check (type-check) | `pnpm typecheck` (agent-core-v2) | pass | Clean. |

## Output Excerpts

```
✓ |agent-core-v2| test/agent/contextInjector/contextInjector.test.ts (21 tests) 48ms
      Tests 21 passed (21)

# fullCompaction suite
      Tests 1 failed | 76 passed (77)
# the single failure (pre-existing, unrelated to this fix):
#   Expected: 32000   Received: 131072  (DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS)
#   at fullCompaction.test.ts:2729 — 'compacts provider overflow when model context size is unknown'
```

## Residual Risks

- **No full e2e run**: the reproduction here is mechanism-level (unit). A true end-to-end run — large context + active TodoList + auto/manual compaction through a live model — was not exercised; it requires a model and a large session. The unit test proves the cancellation path is closed, but the integrated behavior should be confirmed in a real session when convenient.
- **v1 parity**: `packages/agent-core` has its own context-injection path and was not changed; if v1 compaction is still exercised, it would need the equivalent guard.
- **Pre-existing failure**: the unrelated `compactionMaxCompletionTokens` fullCompaction test failure should be triaged separately (see `fix.md` follow-ups).

## Recommendation

Close the bug — verified at the mechanism level. The injector now pauses while compaction runs (mirroring the prompt-service guard that fixed the goal case), so an active TodoList can no longer cancel an in-flight compaction.
