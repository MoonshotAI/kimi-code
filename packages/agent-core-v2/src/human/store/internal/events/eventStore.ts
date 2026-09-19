import { produce } from 'immer';

import type { BranchRef, EntryLine } from '../../storage';
import { StoreError } from '../../storage';

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
  readonly phase: 'open' | 'failed' | 'closed';

  getState(): CombinedState<SM>;
  slice<K extends keyof SM>(name: K): CombinedState<SM>[K];
  select<T>(selector: (state: CombinedState<SM>) => T): T;
  subscribe(listener: (state: CombinedState<SM>, cause: Cause<SM>) => void): () => void;

  dispatch<E extends ExternalEvent>(event: E | readonly E[]): Promise<EntryLine>;
  registerSlice<S>(slice: Slice<string, S>): () => void;
  reset(journal: StoreJournal): Promise<void>;
  ready(): Promise<void>;
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
  private phaseValue: 'open' | 'failed' | 'closed' = 'open';
  private tail: Promise<unknown> = Promise.resolve();
  private failure: { error: unknown } | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly drainLimit: number;
  private readonly report: (error: unknown) => void;
  private readonly listeners = new Set<Listener<SM>>();
  private readonly sliceReadiness = new Map<string, Promise<void>>();

  constructor(opts: EventStoreOptions<SM>) {
    this.journal = opts.journal;
    this.slices = { ...opts.slices };
    this.state = {};
    this.drainLimit = opts.drainLimit ?? DEFAULT_DRAIN_LIMIT;
    const report = opts.onError ?? ((error: unknown) => console.error(error));
    this.report = (error) => {
      try {
        report(error);
      } catch {
        return;
      }
    };
  }

  get ref(): { tree: string; branch: string } {
    return this.journal.ref;
  }

  get phase(): 'open' | 'failed' | 'closed' {
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
    if (this.closePromise !== undefined || this.phaseValue === 'closed') return Promise.reject(new StoreError('closed', 'store is closed'));
    if (this.failure !== undefined) return Promise.reject(this.failure.error);
    const events = (Array.isArray(event) ? event : [event]) as readonly E[];
    for (const item of events) {
      const invalid = validateEvent(item);
      if (invalid !== undefined) {
        return Promise.reject(invalid);
      }
    }
    const readiness = [...this.sliceReadiness.values()];
    const result = this.tail.then(async () => {
      await Promise.all(readiness);
      return this.foldAndAppend(events);
    });
    this.tail = result.then(noop, noop);
    return result;
  }

  registerSlice<S>(slice: Slice<string, S>): () => void {
    this.assertAccepting();
    if (this.slices[slice.name] !== undefined || this.sliceReadiness.has(slice.name)) {
      throw new StoreError('duplicate-slice', `slice '${slice.name}' is already registered`);
    }
    const controller = new AbortController();
    const op = this.tail.then(async () => {
      controller.signal.throwIfAborted();
      this.assertOpen();
      this.slices = { ...this.slices, [slice.name]: slice };
      try {
        await this.refold(this.journal, controller.signal);
      } catch (error) {
        if (this.slices[slice.name] === slice) delete this.slices[slice.name];
        throw error;
      }
      this.notify([{ kind: 'slice-joined', name: slice.name }]);
    });
    this.sliceReadiness.set(slice.name, op);
    this.tail = op.then(noop, noop);
    void op.catch((error: unknown) => { if (!controller.signal.aborted) this.report(error); });
    return () => {
      if (this.sliceReadiness.get(slice.name) !== op) return;
      controller.abort(new StoreError('closed', `slice '${slice.name}' was unregistered`));
      this.sliceReadiness.delete(slice.name);
      const slices = { ...this.slices };
      delete slices[slice.name];
      this.slices = slices;
      const state = { ...this.state };
      delete state[slice.name];
      this.state = state;
    };
  }

  reset(journal: StoreJournal): Promise<void> {
    if (this.closePromise !== undefined || this.phaseValue === 'closed') {
      return Promise.reject(new StoreError('closed', 'store is closed'));
    }
    const op = this.tail.then(async () => {
      if (this.failure !== undefined && journal === this.journal) {
        throw new StoreError('recovery-required', 'reset after a write failure requires a new confirmed journal');
      }
      await journal.settled();
      await this.refold(journal);
      this.journal = journal;
      this.failure = undefined;
      this.phaseValue = 'open';
      this.notify([{ kind: 'reset', state: this.getState() }]);
    });
    this.tail = op.then(noop, noop);
    return op;
  }

  async ready(): Promise<void> {
    this.assertAccepting();
    await Promise.all(this.sliceReadiness.values());
    this.assertAccepting();
  }

  flush(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const op = this.tail.then(() => this.confirmJournal());
    this.tail = op.then(noop, noop);
    return op;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = this.tail.then(() => this.confirmJournal()).finally(() => {
      this.phaseValue = 'closed';
      this.listeners.clear();
    });
    this.tail = this.closePromise.then(noop, noop);
    return this.closePromise;
  }

  private async confirmJournal(): Promise<void> {
    this.assertOpen();
    try {
      await this.journal.settled();
    } catch (error) {
      this.fail(error);
    }
  }

  private assertAccepting(): void {
    if (this.closePromise !== undefined) throw new StoreError('closed', 'store is closing or closed');
    this.assertOpen();
  }

  private assertOpen(): void {
    if (this.phaseValue === 'closed') throw new StoreError('closed', 'store is closed');
    if (this.failure !== undefined) throw this.failure.error;
  }

  private fail(error: unknown): never {
    this.failure = { error };
    this.phaseValue = 'failed';
    throw error;
  }

  async refold(journal: StoreJournal, signal?: AbortSignal): Promise<void> {
    const reading = (async () => {
      const records: JournalRecord[] = [];
      for await (const record of journal.read()) {
        signal?.throwIfAborted();
        records.push(record);
      }
      return records;
    })();
    let cancel = (): void => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal?.reason);
    });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      const records = await Promise.race([reading, cancelled]);
      signal?.throwIfAborted();
      this.foldRecords(records);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  refoldSync(journal: SyncStoreJournal): void {
    this.foldRecords(journal.readSync());
  }

  private foldRecords(records: JournalRecord[]): void {
    const seeded: Record<string, unknown> = {};
    for (const [name, slice] of Object.entries(this.slices)) {
      seeded[name] = slice.initialState();
    }
    const previous = this.state;
    this.state = seeded;
    try {
      for (const record of records) {
        if (record.kind !== EVENT_ENTRY_KIND) continue;
        this.replayRecord(record);
      }
    } catch (error) {
      this.state = previous;
      throw error;
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
      this.assertOpen();
      const ts = typeof event.time === 'number' ? event.time : Date.now();
      const ref: BranchRef = { branch: this.journal.ref.branch, seq: this.journal.nextSeq() };
      const previous = this.state;
      const slices = { ...this.slices };
      let next: Record<string, unknown>;
      let internalCauses: Cause<SM>[];
      const pendingEffects: (() => void)[] = [];
      try {
        const { raised, effects } = this.applyEvent(event, ref, ts, false);
        internalCauses = this.drain(raised, ref, ts, false, pendingEffects);
        pendingEffects.push(...effects);
        next = this.state;
      } finally {
        this.state = previous;
      }
      let entry: EntryLine;
      try {
        entry = await this.journal.append({ type: event.type, kind: EVENT_ENTRY_KIND, data: event });
        await this.journal.settled();
      } catch (error) {
        this.fail(error);
      }
      const committed = { ...this.state };
      for (const [name, slice] of Object.entries(slices)) {
        if (this.slices[name] === slice) committed[name] = next[name];
      }
      this.state = committed;
      for (const effect of pendingEffects) {
        try {
          effect();
        } catch (error) {
          this.report(error);
        }
      }
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
    let changed = false;
    const next: Record<string, unknown> = { ...this.state };
    for (const [name, slice] of Object.entries(this.slices)) {
      const reducer = slice.reducers[event.type];
      if (reducer === undefined) continue;
      const ctx: FoldContext = {
        ref,
        ts,
        replaying,
        enqueue: {
          raise: (internal) => { raised.push(internal); },
          effect: (fn) => {
            effects.push(() => { if (this.slices[name] === slice) fn(); });
          },
        },
      };
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
    pendingEffects: (() => void)[] = [],
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
        pendingEffects.push(...effects);
        causes.push({ kind: 'internal', event: internal });
      }
    }
    return causes;
  }

  private notify(causes: Cause<SM>[]): void {
    const state = this.getState();
    for (const cause of causes) {
      const listeners = [...this.listeners];
      for (const listener of listeners) {
        try {
          listener(state, cause);
        } catch (error) {
          this.report(error);
        }
      }
    }
  }
}

function noop(): void {}
