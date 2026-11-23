import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, shallowRef, type EffectScope, type Ref } from 'vue';
import type { FetchTurnFileChanges, TurnFileChangesResult } from '@moonshot-ai/app-client/contracts';
import type { KimiWebApi, TurnFileHistoryChange } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../../app-client/src/client/deps';
import { createObservationScope } from '../../app-client/src/client/observationScope';
import { clearTurnFileHistorySession, turnFileChangesFetcher } from '../../app-client/src/client/turnFileHistory';
import { useTurnFileStats } from '../src/chat/useTurnFileStats';

const scopes: EffectScope[] = [];
const getTurnFileChanges = vi.fn<KimiWebApi['getTurnFileChanges']>();

function changes(path: string): TurnFileHistoryChange[] {
  return [{ path, status: 'modified', additions: 1, deletions: 0 }];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function queue(ids: Ref<number[]>, fetcher: FetchTurnFileChanges | undefined, enabled = ref(true)) {
  const scope = effectScope();
  scopes.push(scope);
  const stats = scope.run(() => useTurnFileStats(() => ids.value, () => enabled.value, fetcher))!;
  return { scope, stats };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

beforeEach(() => {
  clearTurnFileHistorySession('same');
  getTurnFileChanges.mockReset();
  setKimiClientDeps({ api: () => ({ getTurnFileChanges }) as unknown as KimiWebApi, t: key => key });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  clearTurnFileHistorySession('same');
  resetKimiClientDeps();
  vi.restoreAllMocks();
});

describe('turn file stats queue', () => {
  it('resumes the same session after reset without changing turns or waiting for the cancelled request', async () => {
    const observation = createObservationScope();
    observation.activate('same');
    const old = deferred<TurnFileHistoryChange[]>();
    const fresh = deferred<TurnFileHistoryChange[]>();
    getTurnFileChanges.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
      .mockResolvedValue(changes('older.ts'));
    const fetcher = turnFileChangesFetcher(() => 'same', () => observation.options('same'));
    const ids = ref([2, 1]);
    const originalIds = ids.value;
    const { stats } = queue(ids, fetcher);
    const firstSignal = fetcher.getSignal();
    expect(getTurnFileChanges).toHaveBeenCalledTimes(1);

    observation.reset();
    expect(firstSignal?.aborted).toBe(true);
    expect(stats.value.get(2)).toBe('cancelled');
    expect(stats.value.get(1)).toBe('cancelled');
    observation.activate('same');
    expect(ids.value).toBe(originalIds);
    expect(fetcher.getSignal()).not.toBe(firstSignal);
    await nextTick();
    expect(getTurnFileChanges).toHaveBeenCalledTimes(2);
    fresh.resolve(changes('current.ts'));
    await vi.waitFor(() => expect(stats.value.get(1)).toEqual(changes('older.ts')));
    old.resolve(changes('obsolete.ts'));
    await flush();
    expect(stats.value.get(2)).toEqual(changes('current.ts'));
    expect(getTurnFileChanges.mock.calls.map(([, id]) => id)).toEqual([2, 2, 1]);
    expect(console.warn).not.toHaveBeenCalled();
    observation.reset();
  });

  it('pauses pre-cancelled owners and resumes when a live owner appears', async () => {
    const observation = createObservationScope();
    const fetcher = turnFileChangesFetcher(() => 'same', () => observation.options('same'));
    getTurnFileChanges.mockResolvedValue(changes('ready.ts'));
    const { stats } = queue(ref([1]), fetcher);
    expect(fetcher.getSignal()?.aborted).toBe(true);
    expect(getTurnFileChanges).not.toHaveBeenCalled();
    expect(stats.value.has(1)).toBe(false);
    observation.activate('same');
    await vi.waitFor(() => expect(stats.value.get(1)).toEqual(changes('ready.ts')));
    expect(console.warn).not.toHaveBeenCalled();
    observation.reset();
  });

  it('does not let an old finally release the new drain while its request is pending', async () => {
    const owner = shallowRef(new AbortController().signal);
    const old = deferred<TurnFileChangesResult>();
    const fresh = deferred<TurnFileChangesResult>();
    const read = vi.fn<(id: number) => Promise<TurnFileChangesResult>>()
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise).mockResolvedValue(changes('next.ts'));
    const fetcher = Object.assign(read, { getSignal: () => owner.value });
    const ids = ref([2]);
    const { stats } = queue(ids, fetcher);
    owner.value = new AbortController().signal;
    await nextTick();
    expect(read).toHaveBeenCalledTimes(2);
    old.resolve(changes('obsolete.ts'));
    await flush();
    expect(stats.value.get(2)).toBe('pending');
    ids.value = [3, 2];
    expect(read).toHaveBeenCalledTimes(2);
    fresh.resolve(changes('current.ts'));
    await vi.waitFor(() => expect(stats.value.get(3)).toEqual(changes('next.ts')));
    expect(stats.value.get(2)).toEqual(changes('current.ts'));
    expect(read.mock.calls.map(([id]) => id)).toEqual([2, 2, 3]);
  });

  it.each(['result', 'error'] as const)('does not hide, warn or spend a normal retry on cancellation via %s', async (kind) => {
    const owner = shallowRef(new AbortController().signal);
    const read = vi.fn<(id: number) => Promise<TurnFileChangesResult>>();
    if (kind === 'result') read.mockResolvedValueOnce('cancelled');
    else read.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    read.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(changes('retry.ts'));
    const ids = ref([1]);
    const { stats } = queue(ids, Object.assign(read, { getSignal: () => owner.value }));
    await flush();
    expect(stats.value.get(1)).toBe('cancelled');
    expect(console.warn).not.toHaveBeenCalled();
    owner.value = new AbortController().signal;
    await flush();
    expect(stats.value.get(1)).toBe('failed');
    expect(read).toHaveBeenCalledTimes(2);
    ids.value = [...ids.value];
    await vi.waitFor(() => expect(stats.value.get(1)).toEqual(changes('retry.ts')));
    expect(read).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('retries a real failure only once on a later turn update, not on owner changes', async () => {
    const owner = shallowRef(new AbortController().signal);
    const read = vi.fn<(id: number) => Promise<TurnFileChangesResult>>().mockRejectedValue(new Error('unavailable'));
    const ids = ref([1]);
    const { stats } = queue(ids, Object.assign(read, { getSignal: () => owner.value }));
    await flush();
    expect(stats.value.get(1)).toBe('failed');
    expect(read).toHaveBeenCalledTimes(1);
    owner.value = new AbortController().signal;
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    ids.value = [...ids.value];
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    ids.value = [...ids.value];
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(stats.value.get(1)).toBe('failed');
  });

  it('retains completed changes and genuinely unrecorded summaries across owner changes', async () => {
    const observation = createObservationScope();
    observation.activate('same');
    getTurnFileChanges.mockResolvedValueOnce(changes('done.ts')).mockResolvedValueOnce('unrecorded');
    const ids = ref([2, 1]);
    const { stats } = queue(ids, turnFileChangesFetcher(() => 'same', () => observation.options('same')));
    await vi.waitFor(() => expect(stats.value.get(1)).toBe('hidden'));
    observation.reset();
    observation.activate('same');
    ids.value = [...ids.value];
    await flush();
    expect(stats.value.get(2)).toEqual(changes('done.ts'));
    expect(stats.value.get(1)).toBe('hidden');
    expect(getTurnFileChanges).toHaveBeenCalledTimes(2);
    observation.reset();
  });

  it.each(['disable', 'unmount'] as const)('stops pending work on %s without changing shared ownership', async (action) => {
    const owner = shallowRef(new AbortController().signal);
    const old = deferred<TurnFileChangesResult>();
    const read = vi.fn<(id: number) => Promise<TurnFileChangesResult>>()
      .mockReturnValueOnce(old.promise).mockResolvedValue(changes('resumed.ts'));
    const ids = ref([1]);
    const enabled = ref(false);
    const { scope, stats } = queue(ids, Object.assign(read, { getSignal: () => owner.value }), enabled);
    expect(read).not.toHaveBeenCalled();
    enabled.value = true;
    await nextTick();
    expect(read).toHaveBeenCalledTimes(1);
    if (action === 'disable') enabled.value = false;
    else scope.stop();
    expect(owner.value.aborted).toBe(false);
    old.resolve(changes('obsolete.ts'));
    await flush();
    expect(stats.value.get(1)).toBe('cancelled');
    ids.value = [...ids.value];
    owner.value = new AbortController().signal;
    expect(read).toHaveBeenCalledTimes(1);
    enabled.value = true;
    await flush();
    expect(read).toHaveBeenCalledTimes(action === 'disable' ? 2 : 1);
    expect(stats.value.get(1)).toEqual(action === 'disable' ? changes('resumed.ts') : 'cancelled');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('does not start replacement-owner reads when the old view unmounts in the same update', async () => {
    const first = new AbortController();
    const owner = shallowRef(first.signal);
    const pending = deferred<TurnFileChangesResult>();
    const read = vi.fn<(id: number) => Promise<TurnFileChangesResult>>().mockReturnValue(pending.promise);
    const ids = ref([1]);
    const { scope, stats } = queue(ids, Object.assign(read, { getSignal: () => owner.value }));
    expect(read).toHaveBeenCalledTimes(1);
    first.abort();
    owner.value = new AbortController().signal;
    ids.value = [2, 1];
    scope.stop();
    await nextTick();
    pending.resolve(changes('obsolete.ts'));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(stats.value.get(1)).toBe('cancelled');
    expect(stats.value.has(2)).toBe(false);
  });

  it('supports an unscoped factory and keeps an undefined provider disabled', async () => {
    getTurnFileChanges.mockResolvedValue(changes('unscoped.ts'));
    const fetcher = turnFileChangesFetcher(() => 'same');
    expect(fetcher.getSignal()).toBeUndefined();
    const { stats } = queue(ref([1]), fetcher);
    const disabled = queue(ref([2]), undefined);
    await vi.waitFor(() => expect(stats.value.get(1)).toEqual(changes('unscoped.ts')));
    expect(disabled.stats.value.size).toBe(0);
    expect(getTurnFileChanges).toHaveBeenCalledExactlyOnceWith('same', 1);
  });
});

describe('turn file stats session cache', () => {
  it('restores settled results synchronously when a session view mounts again', async () => {
    getTurnFileChanges.mockResolvedValue(changes('a.ts'));
    const first = queue(ref([3]), turnFileChangesFetcher(() => 'same'));
    await vi.waitFor(() => expect(first.stats.value.get(3)).toEqual(changes('a.ts')));
    first.scope.stop();

    const second = queue(ref([3]), turnFileChangesFetcher(() => 'same'));
    expect(second.stats.value.get(3)).toEqual(changes('a.ts'));
    await flush();
    expect(getTurnFileChanges).toHaveBeenCalledTimes(1);
  });
});
