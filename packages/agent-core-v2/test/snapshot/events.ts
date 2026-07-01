import type { EventSnapshot, EventSnapshotEntry } from '../harness/snapshots';
import { createEventSnapshotter } from '../harness/snapshots';

export type RecordedEventEntry = EventSnapshotEntry & {
  readonly response?: PromiseLike<unknown> & {
    resolve(value: unknown): void;
    reject(reason?: unknown): void;
  };
};

interface PendingWaiter {
  readonly event: string;
  readonly resolve: (entry: RecordedEventEntry) => void;
}

interface PendingAnyWaiter {
  readonly events: readonly string[];
  readonly resolve: (event: string) => void;
}

export function recordAgentEvents() {
  const entries: RecordedEventEntry[] = [];
  const snapshot = createEventSnapshotter();
  const waiters: PendingWaiter[] = [];
  const anyWaiters: PendingAnyWaiter[] = [];
  let drainIndex = 0;

  function push(entry: RecordedEventEntry): RecordedEventEntry {
    entries.push(entry);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (waiter.event === entry.event) {
        waiters.splice(index, 1);
        waiter.resolve(entry);
      }
    }
    for (let index = anyWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = anyWaiters[index]!;
      if (waiter.events.includes(entry.event)) {
        anyWaiters.splice(index, 1);
        waiter.resolve(entry.event);
      }
    }
    return entry;
  }

  function waitFor(event: string): Promise<RecordedEventEntry> {
    const existing = entries.slice(drainIndex).find((entry) => entry.event === event);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      waiters.push({ event, resolve });
    });
  }

  function resolveEntry(entry: RecordedEventEntry, result: unknown): void {
    entry.response?.resolve(result);
  }

  function drainThrough(entry: RecordedEventEntry): EventSnapshot {
    const entryIndex = entries.indexOf(entry);
    if (entryIndex < drainIndex) return snapshot([]);
    const drained = entries.slice(drainIndex, entryIndex + 1);
    drainIndex = entryIndex + 1;
    return snapshot(drained);
  }

  return {
    entries,
    drain(): EventSnapshot {
      const drained = entries.slice(drainIndex);
      drainIndex = entries.length;
      return snapshot(drained);
    },
    async until(event: string): Promise<EventSnapshot> {
      const entry = await waitFor(event);
      return drainThrough(entry);
    },
    async take<T>(event: string): Promise<{
      readonly event: RecordedEventEntry;
      readonly events: EventSnapshot;
      readonly respond: (result: T) => void;
    }> {
      const entry = await waitFor(event);
      return {
        event: entry,
        events: drainThrough(entry),
        respond: (result) => resolveEntry(entry, result),
      };
    },
    once(type: string): Promise<void> {
      return waitFor(type).then(() => {});
    },
    onceAny(types: readonly string[]): Promise<string> {
      const existing = entries.slice(drainIndex).find((entry) => types.includes(entry.event));
      if (existing !== undefined) return Promise.resolve(existing.event);
      return new Promise((resolve) => {
        anyWaiters.push({ events: [...types], resolve });
      });
    },
    recordWire(event: { readonly type: string; readonly [key: string]: unknown }) {
      const { type, ...args } = event;
      return push({
        type: '[wire]',
        event: type,
        args,
      });
    },
    recordEmit(method: string, args: unknown, response?: RecordedEventEntry['response']) {
      return push(
        response === undefined
          ? {
              type: '[rpc]',
              event: method,
              args,
            }
          : {
              type: '[rpc]',
              event: method,
              args,
              response,
            },
      );
    },
    respond(event: RecordedEventEntry, result: unknown): void {
      resolveEntry(event, result);
    },
    respondPending(method: string, id: string, result: unknown): void {
      const pending = entries.find((entry) => {
        if (entry.event !== method || entry.response === undefined) return false;
        if (entry.args === null || typeof entry.args !== 'object') return false;
        const args = entry.args as Record<string, unknown>;
        return args['id'] === id || args['toolCallId'] === id;
      });
      if (pending === undefined) {
        throw new Error(`No pending ${method} event found for ${id}`);
      }
      resolveEntry(pending, result);
    },
  };
}
