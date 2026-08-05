/**
 * `_base.lifecycle` — `Ledger`: an ordered book of rollbackable registrations.
 *
 * A Ledger records entries (disposers, effects, child ledgers) in registration
 * order and tears them down in strict reverse order, awaiting each entry
 * serially — never in parallel. Rollback is uninterruptible: a failing entry
 * is logged (with its label) and teardown continues. Registering into a
 * disposing/disposed ledger throws immediately.
 *
 * The Ledger knows nothing about DI; scopes and containers build on top of it.
 */

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

/** Handle to one ledger entry: remove it, or remove-and-run it. */
export interface LedgerEntry {
  readonly label: string;
  /** True once the entry has been disposed, released, or torn down. */
  readonly disposed: boolean;
  /** Remove the entry and run its disposer (guarded). Idempotent. */
  dispose(reason?: TeardownReason): void | Promise<void>;
  /** Remove the entry without running its disposer. Idempotent. */
  release(): void;
}

interface EntryRecord {
  label: string;
  kind: 'disposer' | 'effect' | 'ledger';
  stack?: string;
  active: boolean;
  run: Disposer;
  /** Set for child-ledger entries, for introspection. */
  ledger?: Ledger;
}

export class Ledger {
  /** Dev-mode toggle: capture the registration stack on every entry. */
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

  /** Number of live entries. */
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
      // Drives the iterator immediately; a mid-iteration throw rolls back the
      // already-yielded disposers before rethrowing (construction failure).
      const run = driveSyncEffect(out);
      return this._push({ label, kind: 'effect', active: true, run });
    }
    return this._push({ label, kind: 'effect', active: true, run: () => {} });
  }

  /** A child ledger is itself one entry of this ledger. */
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

  /**
   * Tear down every entry in strict reverse registration order, awaiting each
   * one serially. Idempotent: a second call while disposing returns the
   * in-flight promise; after disposal it is a no-op. Returns `undefined` when
   * every entry completed synchronously (state is then synchronously
   * `disposed`), otherwise a promise that settles once teardown completes.
   */
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

  /** Tear down all current entries but keep the ledger active. */
  clear(reason: TeardownReason = 'scope-close'): void | Promise<void> {
    this._assertActive('clear');
    return drainRecords(this._records, reason);
  }

  /** Introspection snapshot of the live entries (child ledgers recurse). */
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

  /** Called by a child ledger when it tears itself down. */
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

/** Run one entry's disposer, logging (with label) instead of throwing. */
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

/**
 * Tear down a record list from the tail, serially. Sync fast path: when no
 * entry returns a promise, the whole drain completes within the tick.
 */
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

/** Run a fixed disposer list in reverse, serially, guarding each entry. */
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

/**
 * Drive a sync effect iterator to completion now. On a mid-iteration throw,
 * the already-yielded disposers are rolled back in reverse (sync fast path;
 * an async rollback continues in the background) and the error is rethrown.
 */
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

/** Async counterpart of {@link driveSyncEffect}; resolves to the composite disposer. */
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
