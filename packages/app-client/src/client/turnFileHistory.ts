import { MAX_TURN_DIFF_CHARS } from '@moonshot-ai/app-core/client';
import type { ReadRequestOptions, TurnFileHistoryChange, TurnFileHistoryContent } from '@moonshot-ai/app-core/api';

import { getKimiWebApi } from './deps';
import type { FetchTurnFileChanges, TurnFileChangesResult } from '../contracts';

const cache = new Map<
  string,
  Promise<readonly TurnFileHistoryChange[] | 'unrecorded' | undefined>
>();
const contentCache = new Map<string, Promise<TurnFileHistoryContent | undefined>>();
const contentBytes = new Map<string, number>();
let contentBudget = 0;
const CACHE_CAP = 500;
const CONTENT_ENTRY_BYTE_CAP = MAX_TURN_DIFF_CHARS * 2;
const CONTENT_CACHE_BYTE_BUDGET = 32 * 1024 * 1024;
const CONTENT_CACHE_ENTRY_CAP = 500;

const pendingSignals = new WeakMap<Promise<unknown>, AbortSignal>();

function memoPromise<T>(
  store: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
  afterSettle: (pending: Promise<T>, value: T | undefined) => void,
  signal?: AbortSignal,
): Promise<T> {
  let pending = store.get(key);
  const owner = pending && pendingSignals.get(pending);
  if (owner && (owner.aborted || owner !== signal)) pending = undefined;
  if (pending === undefined) {
    const request = load();
    pending = request;
    store.set(key, request);
    const evict = () => {
      if (store.get(key) === request) store.delete(key);
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', evict);
      pendingSignals.delete(request);
    };
    if (signal) {
      pendingSignals.set(request, signal);
      signal.addEventListener('abort', evict, { once: true });
      if (signal.aborted) evict();
    }
    void request.then(
      (value) => {
        cleanup();
        if (!signal?.aborted && store.get(key) === request) afterSettle(request, value);
      },
      () => {
        cleanup();
        evict();
      },
    );
  }
  return pending;
}

export function clearTurnFileHistorySession(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const key of [...contentCache.keys()]) {
    if (!key.startsWith(prefix)) continue;
    contentCache.delete(key);
    const bytes = contentBytes.get(key);
    if (bytes !== undefined) {
      contentBudget -= bytes;
      contentBytes.delete(key);
    }
  }
}

export function turnFileChangesFetcher(
  getSessionId: () => string | undefined,
  getReadOptions?: () => ReadRequestOptions | undefined,
): FetchTurnFileChanges {
  const fetchChanges = (turnId: number): Promise<TurnFileChangesResult> => {
    const sessionId = getSessionId();
    const options = getReadOptions?.();
    if (!sessionId) return Promise.resolve(undefined);
    if (options?.signal?.aborted) return Promise.resolve('cancelled');
    const key = `${sessionId}:${turnId}`;
    return memoPromise(
      cache,
      key,
      () => {
        const api = getKimiWebApi();
        return options === undefined
          ? api.getTurnFileChanges(sessionId, turnId)
          : api.getTurnFileChanges(sessionId, turnId, options);
      },
      (pending, value) => {
        if (value === 'unrecorded') {
          if (cache.get(key) === pending) cache.delete(key);
          return;
        }
        while (cache.size > CACHE_CAP) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      },
      options?.signal,
    ).then(
      (value): TurnFileChangesResult => options?.signal?.aborted ? 'cancelled' : value === 'unrecorded' ? undefined : value,
      (error: unknown): TurnFileChangesResult => {
        if (options?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return 'cancelled';
        throw error;
      },
    );
  };
  return Object.assign(fetchChanges, { getSignal: () => getReadOptions?.()?.signal });
}

export function turnFileContentFetcher(
  getSessionId: () => string | undefined,
): (
  turnId: number,
  path: string,
  phase: 'start' | 'end',
  sessionId?: string,
) => Promise<TurnFileHistoryContent | undefined> {
  return (turnId, path, phase, sourceSessionId) => {
    const sessionId = sourceSessionId ?? getSessionId();
    if (!sessionId) return Promise.resolve(undefined);
    const key = `${sessionId}:${turnId}:${phase}:${path}`;
    return memoPromise(
      contentCache,
      key,
      () =>
        getKimiWebApi()
          .getTurnFileContent(sessionId, turnId, path, phase)
          .then((content) => content ?? undefined),
      (pending, content) => {
        if (contentCache.get(key) !== pending) return;
        const bytes = (content?.content?.length ?? 0) * 2;
        if (content === undefined || bytes > CONTENT_ENTRY_BYTE_CAP) {
          contentCache.delete(key);
          return;
        }
        contentBytes.set(key, bytes);
        contentBudget += bytes;
        while (contentBudget > CONTENT_CACHE_BYTE_BUDGET || contentBytes.size > CONTENT_CACHE_ENTRY_CAP) {
          const oldest = contentBytes.keys().next().value;
          if (oldest === undefined) break;
          contentBudget -= contentBytes.get(oldest) ?? 0;
          contentBytes.delete(oldest);
          contentCache.delete(oldest);
        }
      },
    );
  };
}
