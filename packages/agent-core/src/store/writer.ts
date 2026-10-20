import { decodeCommit, encodeCommit, isSeq, LogCorruptError, type Commit, type Event, type Op } from './commit';
import { createReplica, type MutableReplica, type Replica } from './replica';

export interface Journal {
  names(prefix: string): Promise<readonly string[]>;
  lines(log: string, from: number): AsyncIterable<string>;
  append(log: string, seq: number, line: string): Promise<void>;
  close(): Promise<void>;
}

export interface Log<E extends Event> {
  readonly name: string;
  readonly version: number;
  readonly replica: Replica<E>;
  commit(op: Op<E>): Promise<number>;
  subscribe(from: number, listener: (commit: Commit<E>, line: string) => void): Promise<() => void>;
}

export interface Writer {
  names(prefix: string): Promise<readonly string[]>;
  open<E extends Event>(name: string): Promise<Log<E>>;
  close(): Promise<void>;
}

export class StoreFailedError extends Error {
  constructor(readonly log: string, cause: unknown) {
    super(`Log '${log}' failed to append; reopen it before writing again`, { cause });
    this.name = 'StoreFailedError';
  }
}

const logName = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

export function openWriter(journal: Journal, options: { onError?: (error: unknown) => void } = {}): Writer {
  const onError = options.onError ?? console.error;
  const logs = new Map<string, Promise<Log<Event>>>();
  const pending = new Set<Promise<unknown>>();
  let clock = 0;
  let closing: Promise<void> | undefined;
  const closed = (): Error => new Error('Writer is closed');
  const report = (error: unknown): void => {
    try {
      onError(error);
    } catch {}
  };

  const createLog = (name: string, replica: MutableReplica<Event>): Log<Event> => {
    let tail: Promise<unknown> = Promise.resolve();
    let failure: { error: unknown } | undefined;
    const listeners = new Set<(commit: Commit<Event>, line: string) => void>();
    const publish = (listener: (commit: Commit<Event>, line: string) => void, commit: Commit<Event>, line: string) => {
      try {
        listener(commit, line);
      } catch (error) {
        report(error);
      }
    };
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
      if (closing !== undefined) return Promise.reject(closed());
      const result = tail.then(() => {
        if (failure !== undefined) throw new StoreFailedError(name, failure.error);
        return operation();
      });
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      tail = settled;
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
      return result;
    };
    return {
      name,
      get version() {
        return replica.version;
      },
      replica,
      commit: (op) =>
        enqueue(async () => {
          const events = op.events ?? [];
          if (op.rewind === undefined && events.length === 0) return replica.version;
          clock = Math.max(Date.now(), clock + 1);
          const line = encodeCommit({ seq: replica.version, time: clock, rewind: op.rewind, events });
          const commit = decodeCommit<Event>(line);
          try {
            await journal.append(name, commit.seq, line);
          } catch (error) {
            failure = { error };
            throw new StoreFailedError(name, error);
          }
          replica.apply(commit);
          for (const listener of Array.from(listeners)) publish(listener, commit, line);
          return replica.version;
        }),
      subscribe: (from, listener) =>
        enqueue(async () => {
          if (!isSeq(from) || from > replica.version) {
            throw new RangeError(`Cannot subscribe to '${name}' from ${from}; version is ${replica.version}`);
          }
          let next = from;
          if (from < replica.version) {
            for await (const line of journal.lines(name, from)) {
              const commit = decodeCommit<Event>(line);
              if (commit.seq < from) continue;
              if (commit.seq !== next) throw new RangeError(`${from} is not a commit boundary of '${name}'`);
              publish(listener, commit, line);
              next = commit.seq + Math.max(1, commit.events?.length ?? 0);
            }
          }
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }),
    };
  };

  const load = async (name: string): Promise<Log<Event>> => {
    const replica = createReplica<Event>(onError);
    let line = 0;
    for await (const text of journal.lines(name, 0)) {
      line += 1;
      const commit = decodeCommit<Event>(text, line);
      if (commit.seq !== replica.version) {
        throw new LogCorruptError(`expected seq ${replica.version}, got ${commit.seq}`, line);
      }
      replica.apply(commit);
      clock = Math.max(clock, commit.time);
    }
    return createLog(name, replica);
  };

  return {
    names: (prefix) => journal.names(prefix),
    open: <E extends Event>(name: string): Promise<Log<E>> => {
      if (closing !== undefined) return Promise.reject(closed());
      if (!logName.test(name)) return Promise.reject(new TypeError(`Invalid log name '${name}'`));
      let log = logs.get(name);
      if (log === undefined) {
        const loading = load(name);
        loading.catch(() => {
          if (logs.get(name) === loading) logs.delete(name);
        });
        logs.set(name, loading);
        log = loading;
      }
      return log as unknown as Promise<Log<E>>;
    },
    close: () =>
      (closing ??= (async () => {
        await Promise.allSettled(logs.values());
        await Promise.allSettled(pending);
        await journal.close();
      })()),
  };
}
