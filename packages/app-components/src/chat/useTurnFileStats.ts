import { onScopeDispose, ref, watch } from 'vue';
import type { FetchTurnFileChanges } from '@moonshot-ai/app-client/contracts';
import type { TurnFileHistoryChange } from '@moonshot-ai/app-core/api';
import { logWarn } from '@moonshot-ai/app-core/lib';

type FileStats = readonly TurnFileHistoryChange[] | 'pending' | 'cancelled' | 'failed' | 'hidden';

type StatsGeneration = {
  signal: AbortSignal | undefined;
  queue: number[];
  draining: boolean;
  onAbort: () => void;
};

export function useTurnFileStats(
  getTurnIds: () => readonly number[],
  isEnabled: () => boolean,
  fetcher: FetchTurnFileChanges | undefined,
) {
  const fetchedFileStats = ref(new Map<number, FileStats>());
  const failures = new Map<number, number>();
  let current: StatsGeneration | undefined;
  let stopped = false;

  function isCurrent(run: StatsGeneration): boolean {
    return !stopped && isEnabled() && current === run &&
      !run.signal?.aborted && fetcher?.getSignal() === run.signal;
  }

  function retire(run: StatsGeneration | undefined): void {
    if (run === undefined) return;
    run.signal?.removeEventListener('abort', run.onAbort);
    run.queue.length = 0;
    if (current !== run) return;
    current = undefined;
    for (const [turnId, state] of fetchedFileStats.value) {
      if (state === 'pending') fetchedFileStats.value.set(turnId, 'cancelled');
    }
  }

  async function drain(run: StatsGeneration): Promise<void> {
    if (run.draining || !isCurrent(run) || fetcher === undefined) return;
    run.draining = true;
    try {
      while (run.queue.length > 0 && isCurrent(run)) {
        const turnId = run.queue.shift()!;
        try {
          const fetched = await fetcher(turnId);
          if (!isCurrent(run)) return;
          fetchedFileStats.value.set(turnId, fetched ?? 'hidden');
        } catch (error) {
          if (!isCurrent(run)) return;
          if (error instanceof Error && error.name === 'AbortError') {
            fetchedFileStats.value.set(turnId, 'cancelled');
            continue;
          }
          failures.set(turnId, (failures.get(turnId) ?? 0) + 1);
          fetchedFileStats.value.set(turnId, 'failed');
          logWarn('turn file changes request failed; the turn files summary stays hidden', {
            turnId,
            error,
          });
        }
      }
    } finally {
      if (current === run) run.draining = false;
    }
  }

  function enqueue(run: StatsGeneration | undefined, retryFailures: boolean): void {
    if (run === undefined || !isCurrent(run)) return;
    const incoming: number[] = [];
    for (const turnId of getTurnIds()) {
      const state = fetchedFileStats.value.get(turnId);
      if (state === 'failed') {
        if (!retryFailures || (failures.get(turnId) ?? 0) >= 2) continue;
      } else if (state !== undefined && state !== 'cancelled') {
        continue;
      }
      fetchedFileStats.value.set(turnId, 'pending');
      incoming.push(turnId);
    }
    run.queue.unshift(...incoming);
    void drain(run);
  }

  const stopTurns = watch(getTurnIds, () => enqueue(current, true), { flush: 'sync' });
  const stopOwner = watch(
    () => [isEnabled(), fetcher?.getSignal()] as const,
    ([enabled, signal]) => {
      retire(current);
      if (stopped || !enabled || fetcher === undefined || signal?.aborted) return;
      const run: StatsGeneration = {
        signal,
        queue: [],
        draining: false,
        onAbort: () => retire(run),
      };
      current = run;
      signal?.addEventListener('abort', run.onAbort, { once: true });
      enqueue(run, false);
    },
    { immediate: true, flush: 'post' },
  );

  onScopeDispose(() => {
    stopped = true;
    stopTurns();
    stopOwner();
    retire(current);
  });

  return fetchedFileStats;
}
