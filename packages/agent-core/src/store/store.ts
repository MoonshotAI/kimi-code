export interface Event {
  readonly type: string;
}

export interface Entry<E extends Event, C> {
  readonly event: E;
  readonly cursor: C;
}

export interface Journal<E extends Event, C> {
  read(): Promise<readonly Entry<E, C>[]>;
  append(event: E): Promise<Entry<E, C>>;
  close(): Promise<void>;
}

export interface Projection<S, E extends Event, C> {
  initial(): S;
  reduce(state: S, event: E, cursor: C): S;
  restore?(entries: readonly Entry<E, C>[]): S;
}

export interface View<S> {
  getState(): S;
  subscribe(listener: (state: S) => void): () => void;
  dispose(): void;
}

export interface Store<S, E extends Event, C> extends Omit<View<S>, 'dispose'> {
  readonly phase: 'open' | 'failed' | 'closing' | 'closed';
  dispatch(event: E | readonly E[]): Promise<Entry<E, C>>;
  onCommit(listener: (entry: Entry<E, C>, state: S) => void): () => void;
  attach<T>(projection: Projection<T, E, C>): View<T>;
  project<T>(projection: Projection<T, E, C>): Promise<View<T>>;
  refresh(change?: () => Promise<unknown>): Promise<void>;
  close(): Promise<void>;
}

export function replay<S, E extends Event, C>(projection: Projection<S, E, C>, entries: readonly Entry<E, C>[]): S {
  if (projection.restore !== undefined) return projection.restore(entries);
  return entries.reduce((state, entry) => projection.reduce(state, entry.event, entry.cursor), projection.initial());
}

type Shape = Record<string, Projection<unknown, Event, unknown>>;
type States<P extends Shape> = { readonly [K in keyof P]: ReturnType<P[K]['initial']> };
type Input<P extends Shape> = Parameters<P[keyof P]['reduce']>[1];
type Position<P extends Shape> = Parameters<P[keyof P]['reduce']>[2];
type Fanout<P extends Shape> = {
  [K in keyof P]: {
    reduce: (state: States<P>[K], event: Input<P>, cursor: Position<P>) => States<P>[K];
    restore?: (entries: readonly Entry<Input<P>, Position<P>>[]) => States<P>[K];
  };
};

export function combine<P extends Shape>(projections: P & Fanout<P>): Projection<States<P>, Input<P>, Position<P>> {
  const map = (fn: (projection: Projection<unknown, Input<P>, Position<P>>, key: keyof P) => unknown): States<P> =>
    Object.fromEntries(Object.entries(projections).map(([key, projection]) => [key, fn(projection, key)])) as States<P>;
  return {
    initial: () => map((projection) => projection.initial()),
    reduce: (state, event, cursor) => {
      const next = map((projection, key) => projection.reduce(state[key], event, cursor));
      return Object.keys(projections).every((key) => Object.is(state[key], next[key])) ? state : next;
    },
    restore: (entries) => map((projection) => replay(projection, entries)),
  };
}

export class CommittedProjectionError<E extends Event, C> extends Error {
  constructor(readonly entry: Entry<E, C>, cause: unknown) {
    super('Event committed; projection failed. Rebuild before writing again.', { cause });
  }
}

export class StoreFailedError extends Error {
  constructor(cause: unknown) {
    super('Store failed; rebuild before writing again.', { cause });
  }
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value) || prototype === Object.prototype || prototype === null) {
      seen.add(value);
      for (const child of Object.values(value)) freeze(child, seen);
      Object.freeze(value);
    }
  }
  return value;
}

export async function openStore<S, E extends Event, C>(options: {
  journal: Journal<E, C>;
  projection: Projection<S, E, C>;
  onError?: (error: unknown) => unknown;
}): Promise<Store<S, E, C>> {
  const { journal } = options;
  let phase: Store<S, E, C>['phase'] = 'open';
  let failure: { error: unknown } | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const commits = new Set<(entry: Entry<E, C>, state: S) => void>();
  const slots = new Set<{
    advance(entry: Entry<E, C>): () => void;
    restore(entries: readonly Entry<E, C>[]): () => void;
    notify(): void;
    dispose(): void;
  }>();
  const report = (error: unknown): void => {
    try { void Promise.resolve((options.onError ?? console.error)(error)).catch(() => {}); } catch {}
  };
  const safely = (fn: () => unknown): void => {
    try { void Promise.resolve(fn()).catch(report); } catch (error) { report(error); }
  };
  const fail = (error: unknown): never => {
    failure = { error };
    phase = 'failed';
    throw error;
  };
  const enqueue = <T,>(operation: () => Promise<T>): Promise<T> => {
    if (closing !== undefined) return Promise.reject(new Error('Store is closing or closed'));
    const result = tail.then(() => {
      if (failure !== undefined) throw new StoreFailedError(failure.error);
      return operation();
    });
    tail = result.then(() => {}, () => {});
    return result;
  };
  const createView = <T,>(projection: Projection<T, E, C>, entries: readonly Entry<E, C>[]): View<T> => {
    let state = freeze(replay(projection, entries));
    let changed = false;
    let disposed = false;
    const listeners = new Set<(state: T) => void>();
    const stage = (next: T): (() => void) => {
      freeze(next);
      return () => { changed = !Object.is(state, next); state = next; };
    };
    const emit = (listener: (state: T) => void): void => safely(() => listener(state));
    const slot = {
      advance: (entry: Entry<E, C>) => stage(projection.reduce(state, entry.event, entry.cursor)),
      restore: (log: readonly Entry<E, C>[]) => stage(replay(projection, log)),
      notify: () => {
        const shouldNotify = changed;
        changed = false;
        if (shouldNotify && !disposed) for (const listener of Array.from(listeners)) emit(listener);
      },
      dispose: () => { disposed = true; listeners.clear(); slots.delete(slot); },
    };
    slots.add(slot);
    return {
      getState: () => state,
      subscribe: (listener) => {
        if (disposed) throw new Error('View is disposed');
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      dispose: slot.dispose,
    };
  };
  const attachNow = <T,>(projection: Projection<T, E, C>): View<T> => {
    if (closing !== undefined) throw new Error('Store is closing or closed');
    if (failure !== undefined) throw new StoreFailedError(failure.error);
    return createView(projection, history);
  };
  let history: Entry<E, C>[] = [];
  let root: View<S>;
  try {
    history = [...await journal.read()];
    root = createView(options.projection, history);
  } catch (error) {
    await journal.close().catch(report);
    throw error;
  }
  return {
    get phase() { return phase; },
    getState: () => root.getState(),
    subscribe: (listener) => root.subscribe(listener),
    dispatch: (event) => {
      const input = (Array.isArray(event) ? event : [event]) as readonly E[];
      let owned: E[];
      try { owned = input.map((item) => freeze(structuredClone(item))); } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        const entries: Entry<E, C>[] = [];
        for (const item of owned) {
          try { entries.push(await journal.append(item)); } catch (error) { return fail(error); }
        }
        try {
          for (const entry of entries) {
            freeze(entry.event);
            Object.freeze(entry);
            history.push(entry);
          }
          const active = Array.from(slots);
          for (const entry of entries) {
            for (const commit of active.map((slot) => slot.advance(entry))) commit();
          }
          for (const slot of active) slot.notify();
          for (const entry of entries) {
            const emit = (listener: (entry: Entry<E, C>, state: S) => void): void => safely(() => listener(entry, root.getState()));
            for (const listener of Array.from(commits)) emit(listener);
          }
          return entries[entries.length - 1] as Entry<E, C>;
        } catch (error) { return fail(new CommittedProjectionError(entries[entries.length - 1] as Entry<E, C>, error)); }
      });
    },
    onCommit: (listener) => {
      if (closing !== undefined) throw new Error('Store is closing or closed');
      commits.add(listener);
      return () => { commits.delete(listener); };
    },
    attach: attachNow,
    project: (projection) => enqueue(async () => attachNow(projection)),
    refresh: (change) => enqueue(async () => {
      try {
        await change?.();
        history = [...await journal.read()];
        const publish = Array.from(slots, (slot) => slot.restore(history));
        for (const commit of publish) commit();
        for (const slot of Array.from(slots)) slot.notify();
      } catch (error) { fail(error); }
    }),
    close: () => {
      if (closing !== undefined) return closing;
      phase = 'closing';
      closing = tail.then(async () => {
        try { await journal.close(); } finally {
          commits.clear();
          for (const slot of Array.from(slots)) slot.dispose();
          phase = 'closed';
        }
      });
      return closing;
    },
  };
}
