import { produce } from 'immer';

import type { BranchRef, EntryLine } from '#/store/types';
import { StoreError } from '#/store/types';

import type { ExternalEvent, InternalEvent } from './events';
import { eventSchemaFor, parseEvent, validateEvent } from './events';
import type { JournalRecord, StoreJournal, SyncStoreJournal } from './journal';
import type { FoldContext, Slice } from './slice';

export type SliceMap = Record<string, Slice<string, any>>;

export type CombinedState<SM extends SliceMap> = {
  readonly [K in keyof SM]: SM[K] extends Slice<string, infer S> ? S : never;
};

export type Cause<SM extends SliceMap = SliceMap> =
  | { kind: 'event'; event: ExternalEvent; entry: EntryLine }
  | { kind: 'internal'; event: InternalEvent }
  | { kind: 'reset'; state: CombinedState<SM> }
  | { kind: 'slice-joined'; name: string };

export interface EventStoreOptions<SM extends SliceMap> {
  journal: StoreJournal;
  slices: SM;
  drainLimit?: number;
  onError?: (error: unknown) => void;
}

export interface EventStore<SM extends SliceMap> {
  readonly ref: { tree: string; branch: string };
  readonly phase: 'open' | 'closed';

  getState(): CombinedState<SM>;
  slice<K extends keyof SM>(name: K): CombinedState<SM>[K];
  select<T>(selector: (state: CombinedState<SM>) => T): T;
  subscribe(listener: (state: CombinedState<SM>, cause: Cause<SM>) => void): () => void;

  dispatch<E extends ExternalEvent>(event: E | readonly E[]): Promise<EntryLine>;
  registerSlice<S>(slice: Slice<string, S>): Promise<() => void>;
  reset(journal: StoreJournal): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

const EVENT_ENTRY_KIND = 'event';
const DEFAULT_DRAIN_LIMIT = 100;

type Listener<SM extends SliceMap> = (state: CombinedState<SM>, cause: Cause<SM>) => void;

export async function createEventStore<SM extends SliceMap>(
  opts: EventStoreOptions<SM>,
): Promise<EventStore<SM>> {
  const store = new EventStoreImpl(opts);
  await store.refold(opts.journal);
  return store;
}

export function createEventStoreSync<SM extends SliceMap>(
  opts: EventStoreOptions<SM> & { journal: SyncStoreJournal },
): EventStore<SM> {
  const store = new EventStoreImpl(opts);
  store.refoldSync(opts.journal);
  return store;
}

class EventStoreImpl<SM extends SliceMap> implements EventStore<SM> {
  private journal: StoreJournal;
  private slices: SliceMap;
  private state: Record<string, unknown>;
  private phaseValue: 'open' | 'closed' = 'open';
  private tail: Promise<unknown> = Promise.resolve();
  private readonly drainLimit: number;
  private readonly report: (error: unknown) => void;
  private readonly listeners = new Set<Listener<SM>>();

  constructor(opts: EventStoreOptions<SM>) {
    this.journal = opts.journal;
    this.slices = { ...opts.slices };
    this.state = {};
    this.drainLimit = opts.drainLimit ?? DEFAULT_DRAIN_LIMIT;
    this.report = opts.onError ?? ((error) => console.error(error));
  }

  get ref(): { tree: string; branch: string } {
    return this.journal.ref;
  }

  get phase(): 'open' | 'closed' {
    return this.phaseValue;
  }

  getState(): CombinedState<SM> {
    return this.state as CombinedState<SM>;
  }

  slice<K extends keyof SM>(name: K): CombinedState<SM>[K] {
    return this.state[name as string] as CombinedState<SM>[K];
  }

  select<T>(selector: (state: CombinedState<SM>) => T): T {
    return selector(this.getState());
  }

  subscribe(listener: Listener<SM>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispatch<E extends ExternalEvent>(event: E | readonly E[]): Promise<EntryLine> {
    if (this.phaseValue !== 'open') {
      return Promise.reject(new StoreError('closed', 'store is closed'));
    }
    const events = (Array.isArray(event) ? event : [event]) as readonly E[];
    for (const item of events) {
      const invalid = validateEvent(item);
      if (invalid !== undefined) {
        return Promise.reject(invalid);
      }
    }
    const result = this.tail.then(() => this.foldAndAppend(events));
    this.tail = result.then(noop, noop);
    return result;
  }

  async registerSlice<S>(slice: Slice<string, S>): Promise<() => void> {
    if (this.phaseValue !== 'open') {
      throw new StoreError('closed', 'store is closed');
    }
    if (this.slices[slice.name] !== undefined) {
      throw new StoreError('duplicate-slice', `slice '${slice.name}' is already registered`);
    }
    const op = this.tail.then(async () => {
      this.slices = { ...this.slices, [slice.name]: slice };
      await this.refold(this.journal);
    });
    this.tail = op.then(noop, noop);
    await op;
    this.notify([{ kind: 'slice-joined', name: slice.name }]);
    return () => {
      const slices = { ...this.slices };
      delete slices[slice.name];
      this.slices = slices;
      const state = { ...this.state };
      delete state[slice.name];
      this.state = state;
    };
  }

  reset(journal: StoreJournal): Promise<void> {
    if (this.phaseValue !== 'open') {
      return Promise.reject(new StoreError('closed', 'store is closed'));
    }
    const op = this.tail.then(async () => {
      await this.journal.settled();
      this.journal = journal;
      await this.refold(journal);
    });
    this.tail = op.then(noop, noop);
    return op.then(() => {
      this.notify([{ kind: 'reset', state: this.getState() }]);
    });
  }

  flush(): Promise<void> {
    return this.tail.then(() => this.journal.settled());
  }

  async close(): Promise<void> {
    await this.flush();
    this.phaseValue = 'closed';
    this.listeners.clear();
  }

  async refold(journal: StoreJournal): Promise<void> {
    const records: JournalRecord[] = [];
    for await (const record of journal.read()) {
      records.push(record);
    }
    this.foldRecords(records);
  }

  refoldSync(journal: SyncStoreJournal): void {
    this.foldRecords(journal.readSync());
  }

  private foldRecords(records: JournalRecord[]): void {
    const seeded: Record<string, unknown> = {};
    for (const [name, slice] of Object.entries(this.slices)) {
      seeded[name] = slice.initialState();
    }
    this.state = seeded;
    for (const record of records) {
      if (record.kind !== EVENT_ENTRY_KIND) continue;
      this.replayRecord(record);
    }
  }

  private replayRecord(record: JournalRecord): void {
    if (eventSchemaFor(record.type) === undefined) return;
    const event = parseEvent(record.type, record.data);
    if (event === undefined) {
      this.report(
        new StoreError('schema', `event '${record.type}' at seq ${record.seq} failed schema validation`),
      );
      return;
    }
    const ref: BranchRef = { branch: record.branch, seq: record.seq };
    const { raised } = this.applyEvent(event, ref, record.ts, true);
    this.drain(raised, ref, record.ts, true);
  }

  private async foldAndAppend(events: readonly ExternalEvent[]): Promise<EntryLine> {
    const causes: Cause<SM>[] = [];
    const entries: EntryLine[] = [];
    for (const event of events) {
      const ts = typeof event.time === 'number' ? event.time : Date.now();
      const ref: BranchRef = { branch: this.journal.ref.branch, seq: this.journal.nextSeq() };
      const { raised, effects } = this.applyEvent(event, ref, ts, false);
      const internalCauses = this.drain(raised, ref, ts, false);
      for (const effect of effects) {
        try {
          effect();
        } catch (error) {
          this.report(error);
        }
      }
      const entry = await this.journal.append({ type: event.type, kind: EVENT_ENTRY_KIND, data: event });
      entries.push(entry);
      causes.push({ kind: 'event', event, entry }, ...internalCauses);
    }
    this.notify(causes);
    return entries[entries.length - 1] as EntryLine;
  }

  private applyEvent(
    event: { type: string },
    ref: BranchRef,
    ts: number,
    replaying: boolean,
  ): { raised: InternalEvent[]; effects: (() => void)[] } {
    const raised: InternalEvent[] = [];
    const effects: (() => void)[] = [];
    const ctx: FoldContext = {
      ref,
      ts,
      replaying,
      enqueue: {
        raise: (internal) => {
          raised.push(internal);
        },
        effect: (fn) => {
          effects.push(fn);
        },
      },
    };
    let changed = false;
    const next: Record<string, unknown> = { ...this.state };
    for (const [name, slice] of Object.entries(this.slices)) {
      const reducer = slice.reducers[event.type];
      if (reducer === undefined) continue;
      changed = true;
      next[name] = produce(next[name], (draft) => reducer(draft, event, ctx));
    }
    if (changed) {
      this.state = next;
    }
    return { raised, effects };
  }

  private drain(
    initial: InternalEvent[],
    ref: BranchRef,
    ts: number,
    replaying: boolean,
  ): Cause<SM>[] {
    const causes: Cause<SM>[] = [];
    const queue = [...initial];
    let count = 0;
    while (queue.length > 0) {
      count += 1;
      if (count > this.drainLimit) {
        throw new StoreError('drain-limit', `internal event drain exceeded limit ${this.drainLimit}`);
      }
      const internal = queue.shift() as InternalEvent;
      const { raised, effects } = this.applyEvent(internal, ref, ts, replaying);
      queue.push(...raised);
      if (!replaying) {
        for (const effect of effects) {
          try {
            effect();
          } catch (error) {
            this.report(error);
          }
        }
        causes.push({ kind: 'internal', event: internal });
      }
    }
    return causes;
  }

  private notify(causes: Cause<SM>[]): void {
    const state = this.getState();
    for (const cause of causes) {
      for (const listener of this.listeners) {
        listener(state, cause);
      }
    }
  }
}

function noop(): void {}
