/**
 * `di` domain — cascade engine + wait scheduler (L2), one per container.
 *
 * Every change (provide / unprovide / update) runs as a single transaction:
 * ① compute the contagion set from the persistent dependency graph;
 * ② broadcast WillCascade to the abort hook (bounded wait, then forced);
 * ③ tear the contagion set down in reverse topological order, serially
 *    (Active → Unloading → Pending, or removed for an unprovided token);
 * ④ apply the change (a replace never passes through the waiting area);
 * ⑤ recheck the waiting area and rebuild satisfied units in topological order;
 * ⑥ append the transaction to the history ring.
 *
 * Requests serialize through a queue; requests queued together merge their
 * contagion sets (deduped by token) into one transaction. Like the Ledger,
 * the engine has a sync fast path: with no async abort wait and no async
 * disposers, a transaction completes within the tick.
 */

import { onUnexpectedError } from '../errors/unexpectedError';
import { isPromiseLike } from '../lifecycle/disposer';
import type { SyncDescriptor } from './descriptors';
import { CascadeConflictError } from './errors';
import type { ServiceIdentifier } from './instantiation';

export type UnitState = 'Pending' | 'Activating' | 'Active' | 'Unloading' | 'Failed';

export type CascadeAction = 'provide' | 'unprovide' | 'update';

/** Eager units activate as soon as their dependencies are satisfied; on-demand units wait for their first resolution (but cascade-torn units always rebuild). */
export type UnitActivation = 'eager' | 'ondemand';

export interface CascadeChange {
  readonly action: CascadeAction;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly token: ServiceIdentifier<any>;
  readonly descriptor?: SyncDescriptor<unknown>;
  readonly pinned?: boolean;
  readonly activation?: UnitActivation;
  readonly reason: string;
}

export interface CascadeHistoryEntry {
  readonly seq: number;
  readonly reason: string;
  readonly changes: ReadonlyArray<{ token: string; action: CascadeAction }>;
  readonly affected: readonly string[];
  readonly tornDown: readonly string[];
  readonly rebuilt: readonly string[];
  readonly failed: readonly string[];
  readonly abortWaited: boolean;
  readonly abortTimedOut: boolean;
  readonly durationMs: number;
}

export interface CascadeEngineOptions {
  /**
   * Abort hook (§4.5): invoked at transaction step ② with the contagion set.
   * A returned promise is awaited up to `abortWaitMs` (best-effort), then the
   * cascade proceeds anyway (forced teardown).
   */
  onWillCascade?: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    affected: readonly ServiceIdentifier<any>[],
    reason: string,
  ) => void | Promise<void>;
  /** Bounded wait for in-flight work to abort (default 5000ms). */
  readonly abortWaitMs?: number;
  /** Suspended-resolution timeout (default 30000ms). */
  readonly resolveTimeoutMs?: number;
  /** History ring capacity (default 200). */
  readonly historyCapacity?: number;
  readonly now?: () => number;
}

/** Container operations the engine drives; implemented by InstantiationService. */
export interface CascadeHost {
  /** Registered in this container or an ancestor. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isRegistered(token: ServiceIdentifier<any>): boolean;
  /** Has a live materialized instance in this container. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isMaterialized(token: ServiceIdentifier<any>): boolean;
  /** Create + cache the instance (throws on construction failure). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  materialize(token: ServiceIdentifier<any>): unknown;
  /** Tear the live instance down and reset the entry to its recipe. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retire(token: ServiceIdentifier<any>): void | Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyProvide(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
    descriptor: SyncDescriptor<unknown>,
    pinned: boolean | undefined,
  ): number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyUnprovide(token: ServiceIdentifier<any>): void;
  /** The unit's recipe: the pending descriptor, or the retained one of a live instance. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recipeOf(token: ServiceIdentifier<any>): SyncDescriptor<unknown> | undefined;
  /** Constructor-declared (instance-edge) dependencies of a recipe. */
  dependenciesOf(
    recipe: SyncDescriptor<unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Array<ServiceIdentifier<any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  affectedSet(tokens: Iterable<ServiceIdentifier<any>>): Set<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ServiceIdentifier<any>
  >;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  topoOrder(tokens: Iterable<ServiceIdentifier<any>>): Array<ServiceIdentifier<any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reverseTopoOrder(tokens: Iterable<ServiceIdentifier<any>>): Array<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ServiceIdentifier<any>
  >;
}

interface UnitRecord {
  state: UnitState;
  error?: unknown;
  activation: UnitActivation;
  /** True once the unit has had a live instance (torn-down units always rebuild). */
  everActive: boolean;
}

interface QueuedRequest {
  readonly change: CascadeChange;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const DEFAULT_ABORT_WAIT_MS = 5000;
const DEFAULT_RESOLVE_TIMEOUT_MS = 30000;
const DEFAULT_HISTORY_CAPACITY = 200;

export class CascadeEngine {
  private readonly _units = new Map<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ServiceIdentifier<any>,
    UnitRecord
  >();
  /** missing dependency token → waiting unit tokens (§5.5 wake intersection). */
  private readonly _pendingIndex = new Map<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ServiceIdentifier<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Set<ServiceIdentifier<any>>
  >();
  private readonly _queue: QueuedRequest[] = [];
  private readonly _history: CascadeHistoryEntry[] = [];
  private _historySeq = 0;
  private _running = false;
  private _disposed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _inFlight = new Set<ServiceIdentifier<any>>();
  private _settleWaiters: Array<() => void> = [];

  constructor(
    private readonly _host: CascadeHost,
    private _options: CascadeEngineOptions = {},
  ) {}

  /** Merge new options (tests configure hooks/timeouts per scenario). */
  configure(options: CascadeEngineOptions): void {
    this._options = { ...this._options, ...options };
  }

  /** State of an engine-tracked unit; undefined for tokens the engine never saw. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unitState(token: ServiceIdentifier<any>): UnitState | undefined {
    return this._units.get(token)?.state;
  }

  /** The sticky failure of a Failed unit. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unitFailure(token: ServiceIdentifier<any>): unknown {
    const unit = this._units.get(token);
    return unit?.state === 'Failed' ? unit.error : undefined;
  }

  /** True while the token sits inside the in-flight transaction's contagion set. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isInFlight(token: ServiceIdentifier<any>): boolean {
    return this._inFlight.has(token);
  }

  history(): readonly CascadeHistoryEntry[] {
    return this._history;
  }

  /** Waiting-area snapshot for introspection: waiting unit → missing tokens. */
  pendingSnapshot(): ReadonlyMap<string, readonly string[]> {
    const snapshot = new Map<string, readonly string[]>();
    for (const [token, unit] of this._units) {
      if (unit.state !== 'Pending') continue;
      snapshot.set(
        token.toString(),
        this._missingDeps(token).map((dep) => dep.toString()),
      );
    }
    return snapshot;
  }

  /**
   * Queue a change. Queued requests merge (deduped by token) into the next
   * transaction. The returned promise settles when the transaction that
   * applied the change completes; with the sync fast path the change is
   * already applied when `submit` returns.
   */
  submit(change: CascadeChange): Promise<void> {
    if (this._disposed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this._queue.push({ change, resolve, reject });
      this._pump();
    });
  }

  /** Explicit reload of a unit (D5): a replace-self transaction. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(token: ServiceIdentifier<any>, reason?: string): Promise<void> {
    return this.submit({
      action: 'update',
      token,
      reason: reason ?? `update ${String(token)}`,
    });
  }

  /** Settles when no transaction is running and the queue is empty. */
  whenIdle(): Promise<void> {
    if (!this._running && this._queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._settleWaiters.push(() => {
        void this.whenIdle().then(resolve);
      });
    });
  }

  /**
   * Async resolution path (§4.3): a token inside the in-flight contagion set
   * suspends until the transaction completes (then resolves); anything else
   * resolves immediately. Times out with `CascadeConflictError`.
   */
  resolveWhenAvailable<T>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.isInFlight(token)) {
      try {
        return Promise.resolve(this._host.materialize(token) as T);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new CascadeConflictError(
            String(token),
            'timed out waiting for the in-flight cascade to settle',
          ),
        );
      }, timeoutMs ?? this._options.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS);
      this._settleWaiters.push(() => {
        clearTimeout(timer);
        try {
          resolve(this._host.materialize(token) as T);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /** Container-side notification: a unit was materialized outside activation. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  observedMaterialization(token: ServiceIdentifier<any>): void {
    const unit = this._units.get(token);
    if (unit !== undefined && unit.state === 'Pending') {
      unit.state = 'Active';
      unit.everActive = true;
      unit.error = undefined;
    }
  }

  dispose(): void {
    this._disposed = true;
    this._units.clear();
    this._pendingIndex.clear();
    this._inFlight = new Set();
    const queued = this._queue.splice(0);
    for (const request of queued) {
      request.resolve();
    }
    const waiters = this._settleWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  // ------------------------------------------------------------------ queue

  private _pump(): void {
    if (this._running || this._disposed) {
      return;
    }
    const batch = this._queue.splice(0);
    if (batch.length === 0) {
      return;
    }
    this._running = true;
    const finish = (error?: unknown): void => {
      this._running = false;
      for (const request of batch) {
        if (error === undefined) {
          request.resolve();
        } else {
          request.reject(error);
        }
      }
      this._settleWaiters.splice(0).forEach((waiter) => { waiter(); });
      this._pump();
    };
    try {
      const out = this._transact(mergeBatch(batch.map((request) => request.change)));
      if (isPromiseLike(out)) {
        Promise.resolve(out).then(
          () => { finish(); },
          (error: unknown) => { finish(error); },
        );
      } else {
        finish();
      }
    } catch (error) {
      finish(error);
    }
  }

  // ------------------------------------------------------------ transaction

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _transact(changes: CascadeChange[]): void | Promise<void> {
    const started = this._options.now?.() ?? Date.now();
    const reason = changes.map((change) => change.reason).join('; ');
    // ① contagion set from the persistent graph (includes the changed tokens).
    const affected = this._host.affectedSet(changes.map((change) => change.token));
    this._inFlight = new Set(affected);
    const complete = (abort: { waited: boolean; timedOut: boolean }): void | Promise<void> => {
      const clear = (): void => {
        this._inFlight = new Set();
      };
      let out: void | Promise<void>;
      try {
        out = this._applyTransaction(changes, affected, reason, started, abort);
      } catch (error) {
        clear();
        throw error;
      }
      if (isPromiseLike(out)) {
        // The contagion set stays in flight until the transaction settles.
        return Promise.resolve(out).then(clear, (error: unknown) => {
          clear();
          throw error;
        });
      }
      clear();
      return undefined;
    };
    // ② WillCascade broadcast → abort hook (bounded wait, best-effort).
    const wait = this._waitForAbort([...affected], reason);
    if (isPromiseLike(wait)) {
      return Promise.resolve(wait).then(complete);
    }
    return complete(wait);
  }

  private _waitForAbort(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    affected: readonly ServiceIdentifier<any>[],
    reason: string,
  ): { waited: boolean; timedOut: boolean } | Promise<{ waited: boolean; timedOut: boolean }> {
    const hook = this._options.onWillCascade;
    if (hook === undefined) {
      return { waited: false, timedOut: false };
    }
    let out: void | Promise<void>;
    try {
      out = hook(affected, reason);
    } catch (error) {
      onUnexpectedError(error);
      return { waited: false, timedOut: false };
    }
    if (!isPromiseLike(out)) {
      return { waited: false, timedOut: false };
    }
    const waitMs = this._options.abortWaitMs ?? DEFAULT_ABORT_WAIT_MS;
    return Promise.race([
      Promise.resolve(out).then(() => ({ waited: true, timedOut: false })),
      new Promise<{ waited: boolean; timedOut: boolean }>((resolve) => {
        setTimeout(() => { resolve({ waited: true, timedOut: true }); }, waitMs);
      }),
    ]);
  }

  private _applyTransaction(
    changes: CascadeChange[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    affected: ReadonlySet<ServiceIdentifier<any>>,
    reason: string,
    started: number,
    abort: { waited: boolean; timedOut: boolean },
  ): void | Promise<void> {
    const tornDown: string[] = [];
    const rebuilt: string[] = [];
    const failed: string[] = [];

    // ③ tear the contagion set down in reverse topological order, serially.
    const teardownOrder = this._host
      .reverseTopoOrder(affected)
      .filter((token) => this._host.isMaterialized(token));
    let index = 0;
    const step = (): void | Promise<void> => {
      while (index < teardownOrder.length) {
        const token = teardownOrder[index]!;
        index += 1;
        this._unitFor(token).state = 'Unloading';
        const out = this._host.retire(token);
        tornDown.push(token.toString());
        const removed = changes.some(
          (change) => change.token === token && change.action === 'unprovide',
        );
        if (!removed) {
          // Dependents and replaced units go back to the waiting area with
          // their recipe retained; the change application below decides the
          // rest. They were live, so they always rebuild.
          this._markPending(token, undefined, true);
        }
        if (isPromiseLike(out)) {
          return Promise.resolve(out).then(step);
        }
      }
      return undefined;
    };

    const after = (): void => {
      // ④ apply the changes (replace = same transaction, no waiting area).
      for (const change of changes) {
        switch (change.action) {
          case 'provide':
            this._host.applyProvide(change.token, change.descriptor!, change.pinned);
            this._markPending(change.token, change.activation ?? 'eager', false);
            break;
          case 'unprovide':
            this._host.applyUnprovide(change.token);
            this._units.delete(change.token);
            break;
          case 'update':
            // Reload of a live-or-failed unit: it rebuilds like a torn one.
            this._markPending(change.token, undefined, true);
            break;
        }
      }
      // ⑤ recheck the waiting area; rebuild satisfied units in topological order.
      this._recheckPending(rebuilt, failed);
      // ⑥ history ring.
      this._pushHistory({
        seq: ++this._historySeq,
        reason,
        changes: changes.map((change) => ({
          token: change.token.toString(),
          action: change.action,
        })),
        affected: [...affected].map((token) => token.toString()),
        tornDown,
        rebuilt,
        failed,
        abortWaited: abort.waited,
        abortTimedOut: abort.timedOut,
        durationMs: (this._options.now?.() ?? Date.now()) - started,
      });
    };

    const drained = step();
    if (isPromiseLike(drained)) {
      return Promise.resolve(drained).then(after);
    }
    after();
    return undefined;
  }

  // ------------------------------------------------------------------ units

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _unitFor(token: ServiceIdentifier<any>): UnitRecord {
    let unit = this._units.get(token);
    if (unit === undefined) {
      unit = { state: 'Pending', activation: 'eager', everActive: false };
      this._units.set(token, unit);
    }
    return unit;
  }

  /** Back to the waiting area; `everActive` marks a cascade-torn unit (always rebuilds). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _markPending(
    token: ServiceIdentifier<any>,
    activation?: UnitActivation,
    everActive?: boolean,
  ): void {
    const unit = this._unitFor(token);
    unit.state = 'Pending';
    unit.error = undefined;
    if (activation !== undefined) {
      unit.activation = activation;
    }
    if (everActive !== undefined) {
      unit.everActive = everActive;
    }
  }

  /**
   * ⑤: iterate to a fixpoint — activating one unit may satisfy the next. Each
   * pass rebuilds the missing-token index (cheap: one sweep of the waiting
   * area) and activates every satisfied unit in topological order. A unit
   * satisfied here was necessarily blocked before this transaction, so
   * activating the whole satisfied set is exactly "就绪自动激活".
   */
  private _recheckPending(rebuilt: string[], failed: string[]): void {
    for (;;) {
      this._pendingIndex.clear();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const satisfied: ServiceIdentifier<any>[] = [];
      for (const [token, unit] of this._units) {
        if (unit.state !== 'Pending') continue;
        const missing = this._missingDeps(token);
        if (missing.length === 0) {
          // On-demand units that were never live wait for their first
          // resolution instead of auto-activating.
          if (unit.everActive || unit.activation === 'eager') {
            satisfied.push(token);
          }
        } else {
          for (const dep of missing) {
            let waiters = this._pendingIndex.get(dep);
            if (waiters === undefined) {
              waiters = new Set();
              this._pendingIndex.set(dep, waiters);
            }
            waiters.add(token);
          }
        }
      }
      if (satisfied.length === 0) {
        return;
      }
      for (const token of this._host.topoOrder(satisfied)) {
        this._activate(token, rebuilt, failed);
      }
      // Materialization pulls descriptor dependencies transitively; sweep the
      // units that became materialized as a side effect.
      for (const [token, unit] of this._units) {
        if (
          (unit.state === 'Pending' || unit.state === 'Activating') &&
          this._host.isMaterialized(token)
        ) {
          unit.state = 'Active';
          unit.everActive = true;
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _activate(token: ServiceIdentifier<any>, rebuilt: string[], failed: string[]): void {
    const unit = this._unitFor(token);
    unit.state = 'Activating';
    unit.error = undefined;
    try {
      this._host.materialize(token);
      unit.state = 'Active';
      unit.everActive = true;
      rebuilt.push(token.toString());
    } catch (error) {
      // D5: Failed is sticky — no automatic retry; explicit update() reloads.
      unit.state = 'Failed';
      unit.error = error;
      failed.push(token.toString());
    }
  }

  /** Missing dependencies of a Pending unit (empty = ready to activate). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _missingDeps(token: ServiceIdentifier<any>): Array<ServiceIdentifier<any>> {
    const recipe = this._host.recipeOf(token);
    if (recipe === undefined) {
      // No recipe to rebuild from (e.g. a foreign-seeded instance that was
      // torn down): the unit can never become satisfied on its own.
      return [token];
    }
    return this._host
      .dependenciesOf(recipe)
      .filter((dep) => !this._isAvailable(dep));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _isAvailable(dep: ServiceIdentifier<any>): boolean {
    if (!this._host.isRegistered(dep)) {
      return false;
    }
    const state = this._units.get(dep)?.state;
    return state === undefined || state === 'Active';
  }

  private _pushHistory(entry: CascadeHistoryEntry): void {
    this._history.push(entry);
    const capacity = this._options.historyCapacity ?? DEFAULT_HISTORY_CAPACITY;
    if (this._history.length > capacity) {
      this._history.splice(0, this._history.length - capacity);
    }
  }
}

/** Queued requests merge: one change per token (latest wins), order preserved. */
function mergeBatch(changes: CascadeChange[]): CascadeChange[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byToken = new Map<ServiceIdentifier<any>, CascadeChange>();
  for (const change of changes) {
    byToken.set(change.token, change);
  }
  return [...byToken.values()];
}
