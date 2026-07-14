import {
  createEventSnapshotter,
  type EventSnapshot,
  type EventSnapshotEntry,
  type WireSnapshotEntry,
} from '../harness/snapshots';
import type { WireRecord } from '#/wire/record';

export interface RpcPromiseLike {
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
}

export type RecordedEventEntry = EventSnapshotEntry & {
  readonly response?: RpcPromiseLike;
};

interface EventWaiter {
  readonly event: string;
  readonly start: number;
  readonly resolve: (events: EventSnapshot) => void;
}

interface OnceWaiter {
  readonly event: string;
  readonly resolve: () => void;
}

interface OnceAnyWaiter {
  readonly events: readonly string[];
  readonly resolve: (event: string) => void;
}

interface TakeWaiter {
  readonly event: string;
  readonly start: number;
  readonly resolve: (value: {
    event: RecordedEventEntry;
    events: EventSnapshot;
    respond(result: unknown): void;
  }) => void;
}

export function recordAgentEvents() {
  const entries: RecordedEventEntry[] = [];
  const snapshot = createEventSnapshotter();
  let cursor = 0;
  const eventWaiters: EventWaiter[] = [];
  const onceWaiters: OnceWaiter[] = [];
  const onceAnyWaiters: OnceAnyWaiter[] = [];
  const takeWaiters: TakeWaiter[] = [];

  const snapshotFrom = (start: number): EventSnapshot => snapshot(entries.slice(start));

  const emit = (entry: RecordedEventEntry): RecordedEventEntry => {
    entries.push(entry);

    for (let index = eventWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = eventWaiters[index]!;
      if (waiter.event !== entry.event) continue;
      eventWaiters.splice(index, 1);
      cursor = Math.max(cursor, entries.length);
      waiter.resolve(snapshotFrom(waiter.start));
    }

    for (let index = onceWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = onceWaiters[index]!;
      if (waiter.event !== entry.event) continue;
      onceWaiters.splice(index, 1);
      waiter.resolve();
    }

    for (let index = onceAnyWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = onceAnyWaiters[index]!;
      if (!waiter.events.includes(entry.event)) continue;
      onceAnyWaiters.splice(index, 1);
      waiter.resolve(entry.event);
    }

    for (let index = takeWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = takeWaiters[index]!;
      if (waiter.event !== entry.event) continue;
      takeWaiters.splice(index, 1);
      cursor = Math.max(cursor, entries.length);
      waiter.resolve({
        event: entry,
        events: snapshotFrom(waiter.start),
        respond(result: unknown) {
          entry.response?.resolve(result);
        },
      });
    }

    return entry;
  };

  return {
    entries,

    drain(): EventSnapshot {
      const events = snapshotFrom(cursor);
      cursor = entries.length;
      return events;
    },

    until(event: string): Promise<EventSnapshot> {
      return new Promise((resolve) => {
        eventWaiters.push({ event, start: cursor, resolve });
      });
    },

    once(event: string): Promise<void> {
      return new Promise((resolve) => {
        onceWaiters.push({ event, resolve });
      });
    },

    onceAny(events: readonly string[]): Promise<string> {
      return new Promise((resolve) => {
        onceAnyWaiters.push({ events, resolve });
      });
    },

    take<T = unknown>(event: string): Promise<{
      event: RecordedEventEntry;
      events: EventSnapshot;
      respond(result: T): void;
    }> {
      return new Promise((resolve) => {
        takeWaiters.push({
          event,
          start: cursor,
          resolve: ({ event: found, events: foundEvents, respond }) => {
            resolve({ event: found, events: foundEvents, respond: (result) => respond(result) });
          },
        });
      });
    },

    recordWire(record: WireRecord): WireSnapshotEntry {
      const { type, ...args } = record;
      return emit({ type: '[wire]', event: type, args }) as WireSnapshotEntry;
    },

    recordEmit(method: string, args: unknown, response?: RpcPromiseLike): RecordedEventEntry {
      return emit({ type: '[rpc]', event: method, args, response });
    },

    respond(entry: RecordedEventEntry, result: unknown): void {
      entry.response?.resolve(result);
    },

    respondPending(method: string, id: string, result: unknown): void {
      const entry = entries.find((candidate) => {
        if (
          candidate.type !== '[rpc]' ||
          candidate.event !== method ||
          candidate.response === undefined
        ) {
          return false;
        }
        const args = candidate.args as {
          readonly id?: unknown;
          readonly toolCallId?: unknown;
        } | null;
        return args?.id === id || args?.toolCallId === id;
      });
      entry?.response?.resolve(result);
    },
  };
}
