import { onUnexpectedError } from '../errors/unexpectedError';
import {
  isAsyncIterable,
  isPromiseLike,
  isSyncIterable,
  type Disposer,
  type EffectBody,
  type TeardownReason,
} from './disposer';
import { LedgerDisposedError } from './errors';

export type LedgerState = 'active' | 'disposing' | 'disposed';

export interface LedgerEntryInfo {
  readonly label: string;
  readonly kind: 'disposer' | 'effect' | 'ledger';
  readonly stack?: string;
  readonly children?: readonly LedgerEntryInfo[];
}

export interface LedgerEntry {
  readonly label: string;
  readonly disposed: boolean;
  dispose(reason?: TeardownReason): void | Promise<void>;
  release(): void;
}

interface EntryRecord {
  label: string;
  kind: 'disposer' | 'effect' | 'ledger';
  stack?: string;
  active: boolean;
  run: Disposer;
  ledger?: Ledger;
}

export class Ledger {
  static captureStacks = false;

  private _state: LedgerState = 'active';
  private readonly _records: EntryRecord[] = [];
  private _teardownPromise: Promise<void> | undefined;
  private _parentEntry: LedgerEntry | undefined;

  constructor(readonly label: string = 'ledger') {}

  get state(): LedgerState {
    return this._state;
  }

  get isActive(): boolean {
    return this._state === 'active';
  }

  get isDisposed(): boolean {
    return this._state === 'disposed';
  }

  get size(): number {
    return this._records.reduce((count, record) => count + (record.active ? 1 : 0), 0);
  }

  register(disposer: Disposer, label: string = 'disposer'): LedgerEntry {
    this._assertActive('register');
    return this._push({ label, kind: 'disposer', active: true, run: disposer });
  }

  effect(body: EffectBody, label: string = 'effect'): LedgerEntry {
    this._assertActive('effect');
    const out = body();
    if (typeof out === 'function') {
      return this._push({ label, kind: 'effect', active: true, run: out });
    }
    if (isPromiseLike(out)) {
      const promise = Promise.resolve(out);
      return this._push({
        label,
        kind: 'effect',
        active: true,
        run: async (reason) => {
          const disposer = await promise;
          if (typeof disposer === 'function') await disposer(reason);
        },
      });
    }
    if (isAsyncIterable(out)) {
      const promise = driveAsyncEffect(out);
      return this._push({
        label,
        kind: 'effect',
        active: true,
        run: async (reason) => {
          const disposer = await promise;
          await disposer(reason);
        },
      });
    }
    if (isSyncIterable(out)) {
      const run = driveSyncEffect(out);
      return this._push({ label, kind: 'effect', active: true, run });
    }
    return this._push({ label, kind: 'effect', active: true, run: () => {} });
  }

  createChild(label: string = 'ledger'): Ledger {
    this._assertActive('createChild');
    const child = new Ledger(label);
    child._parentEntry = this._push({
      label,
      kind: 'ledger',
      active: true,
      run: (reason) => child.teardown(reason),
      ledger: child,
    });
    return child;
  }

  teardown(reason: TeardownReason = 'scope-close'): void | Promise<void> {
    if (this._state !== 'active') {
      return this._teardownPromise;
    }
    this._state = 'disposing';
    this._detachFromParent();
    const out = drainRecords(this._records, reason);
    if (isPromiseLike(out)) {
      this._teardownPromise = Promise.resolve(out).then(() => {
        this._state = 'disposed';
      });
      return this._teardownPromise;
    }
    this._state = 'disposed';
    return undefined;
  }

  clear(reason: TeardownReason = 'scope-close'): void | Promise<void> {
    this._assertActive('clear');
    return drainRecords(this._records, reason);
  }

  entries(): LedgerEntryInfo[] {
    const infos: LedgerEntryInfo[] = [];
    for (const record of this._records) {
      if (!record.active) continue;
      infos.push({
        label: record.label,
        kind: record.kind,
        stack: record.stack,
        children: record.ledger?.entries(),
      });
    }
    return infos;
  }

  private _push(record: EntryRecord): LedgerEntry {
    if (Ledger.captureStacks) {
      record.stack = new Error('Ledger registration').stack;
    }
    this._records.push(record);
    return {
      label: record.label,
      get disposed() {
        return !record.active;
      },
      dispose: (reason: TeardownReason = 'scope-close') => {
        if (!record.active) return undefined;
        record.active = false;
        this._remove(record);
        return runGuarded(record, reason);
      },
      release: () => {
        if (!record.active) return;
        record.active = false;
        this._remove(record);
      },
    };
  }

  private _remove(record: EntryRecord): void {
    const index = this._records.indexOf(record);
    if (index >= 0) {
      this._records.splice(index, 1);
    }
  }

  private _detachFromParent(): void {
    this._parentEntry?.release();
    this._parentEntry = undefined;
  }

  private _assertActive(operation: string): void {
    if (this._state !== 'active') {
      throw new LedgerDisposedError(this.label, operation, this._state);
    }
  }
}

function runGuarded(record: EntryRecord, reason: TeardownReason): void | Promise<void> {
  let out: void | Promise<void>;
  try {
    out = record.run(reason);
  } catch (error) {
    onUnexpectedError(tagged(error, record.label));
    return undefined;
  }
  if (isPromiseLike(out)) {
    return Promise.resolve(out).catch((error: unknown) => {
      onUnexpectedError(tagged(error, record.label));
    });
  }
  return undefined;
}

function tagged(error: unknown, label: string): unknown {
  if (error instanceof Error) {
    error.message = `[ledger:${label}] ${error.message}`;
    return error;
  }
  return new Error(`[ledger:${label}] ${String(error)}`);
}

function drainRecords(records: EntryRecord[], reason: TeardownReason): void | Promise<void> {
  let index = records.length;
  const step = (): void | Promise<void> => {
    while (index > 0) {
      index -= 1;
      const record = records[index]!;
      if (!record.active) continue;
      record.active = false;
      const out = runGuarded(record, reason);
      if (isPromiseLike(out)) {
        return Promise.resolve(out).then(step);
      }
    }
    records.length = 0;
    return undefined;
  };
  return step();
}

function runDisposersReverse(
  disposers: readonly Disposer[],
  reason: TeardownReason,
): void | Promise<void> {
  let index = disposers.length;
  const step = (): void | Promise<void> => {
    while (index > 0) {
      index -= 1;
      const disposer = disposers[index]!;
      let out: void | Promise<void>;
      try {
        out = disposer(reason);
      } catch (error) {
        onUnexpectedError(tagged(error, 'effect'));
        continue;
      }
      if (isPromiseLike(out)) {
        return Promise.resolve(out)
          .catch((error: unknown) => { onUnexpectedError(tagged(error, 'effect')); })
          .then(step);
      }
    }
    return undefined;
  };
  return step();
}

function collect(step: IteratorResult<Disposer | void>, disposers: Disposer[]): void {
  if (typeof step.value === 'function') {
    disposers.push(step.value);
  }
}

function driveSyncEffect(iterable: Iterable<Disposer | void>): Disposer {
  const disposers: Disposer[] = [];
  const iterator = iterable[Symbol.iterator]();
  try {
    let step = iterator.next();
    while (!step.done) {
      collect(step, disposers);
      step = iterator.next();
    }
    collect(step, disposers);
  } catch (error) {
    const rollback = runDisposersReverse(disposers, 'unload');
    if (isPromiseLike(rollback)) {
      Promise.resolve(rollback).catch((error: unknown) => { onUnexpectedError(error); });
    }
    throw error;
  }
  return (reason) => runDisposersReverse(disposers, reason);
}

async function driveAsyncEffect(iterable: AsyncIterable<Disposer | void>): Promise<Disposer> {
  const disposers: Disposer[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    let step = await iterator.next();
    while (!step.done) {
      collect(step, disposers);
      step = await iterator.next();
    }
    collect(step, disposers);
  } catch (error) {
    await runDisposersReverse(disposers, 'unload');
    throw error;
  }
  return (reason) => runDisposersReverse(disposers, reason);
}
