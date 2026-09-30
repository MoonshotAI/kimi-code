import type { MediaSource } from '#/llm/message';

export interface MemoLimits {
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_MEMO_LIMITS: MemoLimits = {
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

export interface MediaBudget {
  readonly maxBytes: number;
  readonly lowBytes: number;
}

export const DEFAULT_MEDIA_BUDGET: MediaBudget = {
  maxBytes: 20 * 1024 * 1024,
  lowBytes: 10 * 1024 * 1024,
};

export interface StoreRefResolverOptions {
  readonly memo?: MemoLimits;
  readonly budget?: MediaBudget;
}

export interface MemoEntry {
  readonly source: MediaSource;
  readonly expiresAt?: number;
}

export interface Memo {
  get(key: string): MemoEntry | undefined;
  set(key: string, value: MemoEntry, bytes: number): void;
}

export interface StoreRefSession {
  readonly memo: Memo;
  readonly budget: MediaBudget;
  readonly budgetDropped: Set<string>;
}

function createMemo(limits: MemoLimits): Memo {
  const entries = new Map<string, { readonly value: MemoEntry; readonly bytes: number }>();
  let total = 0;
  const evict = (key: string): void => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    total -= entry.bytes;
  };
  return {
    get: (key) => {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set: (key, value, bytes) => {
      evict(key);
      if (bytes > limits.maxEntryBytes) return;
      entries.set(key, { value, bytes });
      total += bytes;
      for (const oldest of entries.keys()) {
        if (total <= limits.maxTotalBytes) return;
        evict(oldest);
      }
    },
  };
}

export function createSession(options?: StoreRefResolverOptions): StoreRefSession {
  return {
    memo: createMemo(options?.memo ?? DEFAULT_MEMO_LIMITS),
    budget: options?.budget ?? DEFAULT_MEDIA_BUDGET,
    budgetDropped: new Set(),
  };
}
