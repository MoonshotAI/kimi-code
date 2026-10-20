import { LogCorruptError, type Commit, type Event } from './commit';

export interface Entry<E extends Event> {
  readonly seq: number;
  readonly time: number;
  readonly event: E;
}

export interface Projection<S, E extends Event> {
  initial(): S;
  reduce(state: S, entry: Entry<E>): S;
}

export interface View<S> {
  getState(): S;
  subscribe(listener: (state: S) => void): () => void;
  dispose(): void;
}

export interface Replica<E extends Event> {
  readonly version: number;
  entries(): readonly Entry<E>[];
  view<S>(projection: Projection<S, E>): View<S>;
}

export interface MutableReplica<E extends Event> extends Replica<E> {
  apply(commit: Commit<E>): void;
}

function fold<S, E extends Event>(projection: Projection<S, E>, state: S, entries: readonly Entry<E>[]): S {
  let next = state;
  for (const entry of entries) next = projection.reduce(next, entry);
  return next;
}

export function createReplica<E extends Event>(onError: (error: unknown) => void = console.error): MutableReplica<E> {
  let version = 0;
  const log: Entry<E>[] = [];
  const updates = new Set<(rewound: boolean, added: readonly Entry<E>[]) => void>();
  const report = (error: unknown): void => {
    try {
      onError(error);
    } catch {}
  };
  return {
    get version() {
      return version;
    },
    entries: () => log.slice(),
    apply: (commit) => {
      if (commit.seq !== version) throw new LogCorruptError(`expected seq ${version}, got ${commit.seq}`);
      const { rewind } = commit;
      if (rewind !== undefined) {
        if (rewind > commit.seq) throw new LogCorruptError(`cannot rewind to ${rewind} at version ${commit.seq}`);
        log.length = log.findLastIndex((entry) => entry.seq < rewind) + 1;
      }
      const added = (commit.events ?? []).map((event, index) =>
        Object.freeze({ seq: commit.seq + index, time: commit.time, event }),
      );
      for (const entry of added) log.push(entry);
      version = commit.seq + Math.max(1, added.length);
      for (const update of Array.from(updates)) update(rewind !== undefined, added);
    },
    view: <S>(projection: Projection<S, E>): View<S> => {
      let state = fold(projection, projection.initial(), log);
      let disposed = false;
      const listeners = new Set<(state: S) => void>();
      const dispose = (): void => {
        disposed = true;
        listeners.clear();
        updates.delete(update);
      };
      const update = (rewound: boolean, added: readonly Entry<E>[]): void => {
        let next: S;
        try {
          next = rewound ? fold(projection, projection.initial(), log) : fold(projection, state, added);
        } catch (error) {
          dispose();
          report(error);
          return;
        }
        if (Object.is(next, state)) return;
        state = next;
        for (const listener of Array.from(listeners)) {
          try {
            listener(state);
          } catch (error) {
            report(error);
          }
        }
      };
      updates.add(update);
      return {
        getState: () => state,
        subscribe: (listener) => {
          if (disposed) throw new Error('View is disposed');
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        dispose,
      };
    },
  };
}
