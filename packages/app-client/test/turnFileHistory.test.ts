import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KimiWebApi, TurnFileHistoryChange } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import {
  clearTurnFileHistorySession,
  turnFileChangesFetcher,
  turnFileContentFetcher,
} from '../src/client/turnFileHistory';

const getTurnFileChanges = vi.fn<KimiWebApi['getTurnFileChanges']>();
const getTurnFileContent = vi.fn<KimiWebApi['getTurnFileContent']>();

function changes(path: string): TurnFileHistoryChange[] {
  return [{ path, status: 'modified', additions: 1, deletions: 0 }];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  clearTurnFileHistorySession('s1');
  clearTurnFileHistorySession('s2');
  getTurnFileChanges.mockReset();
  getTurnFileContent.mockReset();
  setKimiClientDeps({
    api: () => ({ getTurnFileChanges, getTurnFileContent }) as unknown as KimiWebApi,
    t: (key) => key,
  });
});

afterEach(() => {
  resetKimiClientDeps();
});

describe('turnFileChangesFetcher', () => {
  it('exposes the latest signal through its callable contract', () => {
    let controller = new AbortController();
    const fetcher = turnFileChangesFetcher(() => 's1', () => ({ signal: controller.signal }));
    const first = fetcher.getSignal();
    expect(first).toBe(controller.signal);
    controller.abort();
    controller = new AbortController();
    expect(fetcher.getSignal()).toBe(controller.signal);
    expect(fetcher.getSignal()).not.toBe(first);
    expect(first?.aborted).toBe(true);
    expect(getTurnFileChanges).not.toHaveBeenCalled();
  });

  it('allows an unscoped callable and preserves missing-session results', async () => {
    const fetcher = turnFileChangesFetcher(() => undefined);
    expect(fetcher.getSignal()).toBeUndefined();
    expect(await fetcher(1)).toBeUndefined();
    expect(getTurnFileChanges).not.toHaveBeenCalled();
  });

  it('reports transport cancellation separately from unrecorded changes', async () => {
    getTurnFileChanges.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'))
      .mockResolvedValueOnce('unrecorded');
    const fetcher = turnFileChangesFetcher(() => 's1');
    expect(await fetcher(1)).toBe('cancelled');
    expect(await fetcher(1)).toBeUndefined();
    expect(getTurnFileChanges).toHaveBeenCalledTimes(2);
  });

  it('keeps the existing call shape and caches completed reads', async () => {
    getTurnFileChanges.mockResolvedValue(changes('a.ts'));
    const fetcher = turnFileChangesFetcher(() => 's1');

    expect(await fetcher(1)).toEqual(changes('a.ts'));
    expect(await fetcher(1)).toEqual(changes('a.ts'));
    expect(getTurnFileChanges).toHaveBeenCalledExactlyOnceWith('s1', 1);
  });

  it('skips already cancelled reads without disturbing another owner', async () => {
    getTurnFileChanges.mockResolvedValue(changes('a.ts'));
    const fetcher = turnFileChangesFetcher(() => 's1');
    await fetcher(1);
    const cancelled = turnFileChangesFetcher(() => 's1', () => ({ signal: AbortSignal.abort() }));

    expect(await cancelled(1)).toBe('cancelled');
    expect(await fetcher(1)).toEqual(changes('a.ts'));
    expect(getTurnFileChanges).toHaveBeenCalledTimes(1);
  });

  it('evicts aborted A-B-A promises before they settle and ignores their stale results', async () => {
    const old = deferred<TurnFileHistoryChange[]>();
    const current = deferred<TurnFileHistoryChange[]>();
    let sessionId = 's1';
    let controller = new AbortController();
    getTurnFileChanges
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(changes('b.ts'))
      .mockReturnValueOnce(current.promise);
    const fetcher = turnFileChangesFetcher(() => sessionId, () => ({ signal: controller.signal, background: true }));

    const first = fetcher(1);
    expect(getTurnFileChanges).toHaveBeenCalledWith('s1', 1, { signal: controller.signal, background: true });
    controller.abort();
    sessionId = 's2';
    controller = new AbortController();
    await fetcher(1);
    controller.abort();
    sessionId = 's1';
    controller = new AbortController();
    const second = fetcher(1);
    expect(getTurnFileChanges).toHaveBeenCalledTimes(3);
    old.resolve(changes('old.ts'));
    expect(await first).toBe('cancelled');
    const duplicate = fetcher(1);
    expect(getTurnFileChanges).toHaveBeenCalledTimes(3);
    current.resolve(changes('new.ts'));
    expect(await second).toEqual(changes('new.ts'));
    expect(await duplicate).toEqual(changes('new.ts'));
    expect(await fetcher(1)).toEqual(changes('new.ts'));
    expect(getTurnFileChanges).toHaveBeenCalledTimes(3);
  });

  it('isolates pending cancellation owners and abort only evicts its own promise', async () => {
    const old = deferred<TurnFileHistoryChange[]>();
    const current = deferred<TurnFileHistoryChange[]>();
    const firstOwner = new AbortController();
    const secondOwner = new AbortController();
    getTurnFileChanges.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const firstFetcher = turnFileChangesFetcher(() => 's1', () => ({ signal: firstOwner.signal }));
    const secondFetcher = turnFileChangesFetcher(() => 's1', () => ({ signal: secondOwner.signal }));

    const first = firstFetcher(1);
    const second = secondFetcher(1);
    expect(getTurnFileChanges).toHaveBeenCalledTimes(2);
    firstOwner.abort();
    const duplicate = secondFetcher(1);
    expect(getTurnFileChanges).toHaveBeenCalledTimes(2);
    current.resolve(changes('new.ts'));
    expect(await second).toEqual(changes('new.ts'));
    expect(await duplicate).toEqual(changes('new.ts'));
    old.reject(new DOMException('cancelled', 'AbortError'));
    expect(await first).toBe('cancelled');
    expect(await secondFetcher(1)).toEqual(changes('new.ts'));
    expect(getTurnFileChanges).toHaveBeenCalledTimes(2);
  });

  it('shares completed caches across owners after the original observer is cancelled', async () => {
    getTurnFileChanges.mockResolvedValue(changes('a.ts'));
    const controller = new AbortController();
    const observed = turnFileChangesFetcher(() => 's1', () => ({ signal: controller.signal }));
    await observed(1);
    controller.abort();
    const other = turnFileChangesFetcher(() => 's1', () => ({ signal: new AbortController().signal }));

    expect(await other(1)).toEqual(changes('a.ts'));
    expect(getTurnFileChanges).toHaveBeenCalledTimes(1);
  });

  it('shares an uncancellable in-flight request without letting an observer evict it', async () => {
    const request = deferred<TurnFileHistoryChange[]>();
    const controller = new AbortController();
    getTurnFileChanges.mockReturnValueOnce(request.promise);
    const explicitFetcher = turnFileChangesFetcher(() => 's1');
    const observedFetcher = turnFileChangesFetcher(() => 's1', () => ({ signal: controller.signal }));
    const explicit = explicitFetcher(1);
    const observed = observedFetcher(1);
    controller.abort();
    request.resolve(changes('a.ts'));

    expect(await explicit).toEqual(changes('a.ts'));
    expect(await observed).toBe('cancelled');
    expect(await explicitFetcher(1)).toEqual(changes('a.ts'));
    expect(getTurnFileChanges).toHaveBeenCalledExactlyOnceWith('s1', 1);
  });

  it('does not attach an explicit read to a cancellable observation', async () => {
    const request = deferred<TurnFileHistoryChange[]>();
    const controller = new AbortController();
    getTurnFileChanges.mockReturnValueOnce(request.promise).mockResolvedValueOnce(changes('explicit.ts'));
    const observed = turnFileChangesFetcher(() => 's1', () => ({ signal: controller.signal }))(1);
    const explicitFetcher = turnFileChangesFetcher(() => 's1');
    expect(await explicitFetcher(1)).toEqual(changes('explicit.ts'));
    controller.abort();
    request.resolve(changes('old.ts'));

    expect(await observed).toBe('cancelled');
    expect(await explicitFetcher(1)).toEqual(changes('explicit.ts'));
    expect(getTurnFileChanges).toHaveBeenCalledTimes(2);
  });

  it('preserves ordinary failures and retries rejected or unrecorded results', async () => {
    getTurnFileChanges
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce('unrecorded')
      .mockResolvedValueOnce(changes('a.ts'));
    const fetcher = turnFileChangesFetcher(() => 's1');

    await expect(fetcher(1)).rejects.toThrow('unavailable');
    expect(await fetcher(1)).toBeUndefined();
    expect(await fetcher(1)).toEqual(changes('a.ts'));
    expect(getTurnFileChanges).toHaveBeenCalledTimes(3);
  });
});

describe('turnFileContentFetcher', () => {
  it('keeps explicit content reads independent of automatic changes cancellation', async () => {
    const controller = new AbortController();
    const changesRequest = deferred<TurnFileHistoryChange[]>();
    const contentRequest = deferred<{ version: number; content: string }>();
    getTurnFileChanges.mockReturnValueOnce(changesRequest.promise);
    getTurnFileContent.mockReturnValueOnce(contentRequest.promise);
    const observed = turnFileChangesFetcher(() => 's1', () => ({ signal: controller.signal }))(1);
    const fetchContent = turnFileContentFetcher(() => 's1');
    const content = fetchContent(1, 'a.ts', 'end');
    controller.abort();
    changesRequest.resolve(changes('a.ts'));
    contentRequest.resolve({ version: 1, content: 'file content' });

    expect(await observed).toBe('cancelled');
    expect(await content).toEqual({ version: 1, content: 'file content' });
    expect(await fetchContent(1, 'a.ts', 'end')).toEqual({ version: 1, content: 'file content' });
    expect(getTurnFileContent).toHaveBeenCalledExactlyOnceWith('s1', 1, 'a.ts', 'end');
  });

  it('preserves source session overrides and session cache clearing', async () => {
    getTurnFileContent.mockResolvedValue({ version: 1, content: 'content' });
    const fetchContent = turnFileContentFetcher(() => 's1');
    await fetchContent(1, 'a.ts', 'start', 's2');
    expect(getTurnFileContent).toHaveBeenCalledExactlyOnceWith('s2', 1, 'a.ts', 'start');
    clearTurnFileHistorySession('s2');
    await fetchContent(1, 'a.ts', 'start', 's2');
    expect(getTurnFileContent).toHaveBeenCalledTimes(2);
  });
});


it('caches supported large snapshots while enforcing the entry limit', async () => {
  const fetch = turnFileContentFetcher(() => 's1');
  getTurnFileContent.mockResolvedValue({ version: 1, content: 'x'.repeat(1024 * 1024) });
  await fetch(1, 'large.ts', 'start');
  await fetch(1, 'large.ts', 'start');
  expect(getTurnFileContent).toHaveBeenCalledTimes(1);
  getTurnFileContent.mockResolvedValue({ version: 1, content: 'x'.repeat(1024 * 1024 + 1) });
  await fetch(1, 'oversized.ts', 'end');
  await fetch(1, 'oversized.ts', 'end');
  expect(getTurnFileContent).toHaveBeenCalledTimes(3);
});

it('evicts old large snapshots when the total cache exceeds 32 MiB', async () => {
  const fetch = turnFileContentFetcher(() => 's1');
  getTurnFileContent.mockResolvedValue({ version: 1, content: 'x'.repeat(1024 * 1024) });
  for (let i = 0; i < 17; i++) await fetch(1, `file-${i}.ts`, 'end');
  await fetch(1, 'file-16.ts', 'end');
  expect(getTurnFileContent).toHaveBeenCalledTimes(17);
  await fetch(1, 'file-0.ts', 'end');
  expect(getTurnFileContent).toHaveBeenCalledTimes(18);
});
