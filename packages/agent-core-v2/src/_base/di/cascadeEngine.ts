/**
 * `di` domain — cascade engine + wait scheduler (L2), one per container, with
 * tree-wide orchestration (D9: cascades propagate along instance edges across
 * scopes).
 *
 * The dependency graph, request queue, in-flight set, and settle waiters are
 * shared by the whole scope tree (`CascadeTree`, owned by the root). Every
 * change (provide / unprovide / update) runs as a single transaction
 * orchestrated by the engine of the scope where the change was submitted:
 * ① compute the contagion set from the tree-global graph;
 * ② broadcast WillCascade to the orchestrator's abort hook (bounded wait,
 *    then forced; failures are best-effort, never a veto);
 * ③ tear the contagion set down in global reverse topological order, serially
 *    (each scope's engine executes its own units; Active → Unloading →
 *    Pending, or removed for an unprovided token; a descendant scope that dies
 *    mid-transaction is skipped idempotently);
 * ④ apply the change in its own scope (a replace never passes through the
 *    waiting area);
 * ⑤ recheck the waiting area across scopes and rebuild satisfied units in
 *    global topological order;
 * ⑥ append the transaction to the orchestrator's history ring.
 *
 * Requests serialize through the tree queue; requests queued together merge
 * their contagion sets (deduped by scope+token) into one transaction. This is
 * one transaction across the tree but not a distributed transaction: a single
 * orchestrator, a deterministic order, local execution per scope. Like the
 * Ledger, the engine has a sync fast path: with no async abort wait and no
 * async disposers, a transaction completes within the tick.
 */

import { onUnexpectedError } from '../errors/unexpectedError';
import { isPromiseLike } from '../lifecycle/disposer';
import type { SyncDescriptor } from './descriptors';
import {
  PairIndex,
  type DependencyGraph,
  type ScopedToken,
} from './dependencyGraph';
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
  /** Pre-materialized value for a `provide` change (mutually exclusive with `descriptor`). */
  readonly instance?: unknown;
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
    affected: readonly ScopedToken[],
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

/** Container operations one engine drives for its own scope's units. */
export interface CascadeHost {
  /** Registered in this container or an ancestor. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isRegistered(token: ServiceIdentifier<any>): boolean;
  /** The container owning this token in this container's chain, if any. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ownerScopeOf(token: ServiceIdentifier<any>): object | undefined;
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
  /** Register a pre-materialized instance (a new generation). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyProvideInstance(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
    instance: unknown,
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
}

/** Structural handle a scoped token's `scope` provides to the engine. */
export interface CascadeScopeHandle {
  readonly cascade: CascadeEngine;
  readonly cascadeDisposed: boolean;
  /** Distance from the tree root (root = 0); parents always sort shallower. */
  readonly cascadeDepth: number;
}

interface UnitRecord {
  state: UnitState;
  error?: unknown;
  activation: UnitActivation;
  /** True once the unit has had a live instance (torn-down units always rebuild). */
  everActive: boolean;
}

interface QueuedRequest {
  readonly engine: CascadeEngine;
  readonly change: CascadeChange;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const DEFAULT_ABORT_WAIT_MS = 5000;
const DEFAULT_RESOLVE_TIMEOUT_MS = 30000;
const DEFAULT_HISTORY_CAPACITY = 200;

/**
 * Tree-wide cascade runtime, owned by the root container and shared by every
 * engine of the scope tree: the persistent graph, the serialized request
 * queue, the in-flight contagion set of the running transaction, and the
 * settle waiters for suspended resolutions.
 */
export class CascadeTree {
  readonly graph: DependencyGraph;
  readonly queue: QueuedRequest[] = [];
  /** Every live engine of the tree (engines register at construction). */
  readonly engines = new Set<CascadeEngine>();
  running = false;
  /** The scope orchestrating the running transaction (for label rendering). */
  orchestrator: object | undefined;
  private readonly _inFlight = new PairIndex<true>();
  private _settleWaiters: Array<() => void> = [];
  private readonly _scopeSeq = new Map<object, number>();
  private _nextScopeSeq = 0;

  constructor(graph: DependencyGraph) {
    this.graph = graph;
  }

  inFlightSet(ref: ScopedToken, on: boolean): void {
    if (on) {
      this._inFlight.set(ref.scope, ref.token, true);
    } else {
      this._inFlight.delete(ref.scope, ref.token);
    }
  }

  inFlightHas(ref: ScopedToken): boolean {
    return this._inFlight.get(ref.scope, ref.token) !== undefined;
  }

  inFlightClear(refs: Iterable<ScopedToken>): void {
    for (const ref of refs) {
      this._inFlight.delete(ref.scope, ref.token);
    }
  }

  /** Stable per-scope sequence used to render cross-scope labels (`#n:token`). */
  seqOf(scope: object): number {
    let seq = this._scopeSeq.get(scope);
    if (seq === undefined) {
      seq = this._nextScopeSeq++;
      this._scopeSeq.set(scope, seq);
    }
    return seq;
  }

  addSettleWaiter(waiter: () => void): void {
    this._settleWaiters.push(waiter);
  }

  fireSettleWaiters(): void {
    const waiters = this._settleWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }
}

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
  private readonly _history: CascadeHistoryEntry[] = [];
  private _historySeq = 0;
  private _disposed = false;

  constructor(
    private readonly _host: CascadeHost,
    private readonly _scope: CascadeScopeHandle,
    private readonly _tree: CascadeTree,
    private _options: CascadeEngineOptions = {},
  ) {
    this._tree.engines.add(this);
  }

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

  /** True while the scoped token sits inside the running transaction's contagion set. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isInFlight(token: ServiceIdentifier<any>): boolean {
    const owner = this._host.ownerScopeOf(token) ?? this._scope;
    return this._tree.inFlightHas({ scope: owner, token });
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
   * Queue a change on the tree. Queued requests merge (deduped by
   * scope+token) into the next transaction. The returned promise settles when
   * the transaction that applied the change completes; with the sync fast
   * path the change is already applied when `submit` returns.
   */
  submit(change: CascadeChange): Promise<void> {
    if (this._disposed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this._tree.queue.push({ engine: this, change, resolve, reject });
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

  /** Settles when no transaction is running and the tree queue is empty. */
  whenIdle(): Promise<void> {
    if (!this._tree.running && this._tree.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._tree.addSettleWaiter(() => {
        void this.whenIdle().then(resolve);
      });
    });
  }

  /**
   * Async resolution path (§4.3): a token inside the running transaction's
   * contagion set suspends until the transaction completes (then resolves);
   * anything else resolves immediately. Times out with `CascadeConflictError`.
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
      this._tree.addSettleWaiter(() => {
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
    this._tree.engines.delete(this);
    this._units.clear();
    this._pendingIndex.clear();
    // Only this engine's queued requests are withdrawn; the tree queue keeps
    // serving the other scopes.
    const remaining: QueuedRequest[] = [];
    for (const request of this._tree.queue) {
      if (request.engine === this) {
        request.resolve();
      } else {
        remaining.push(request);
      }
    }
    this._tree.queue.length = 0;
    this._tree.queue.push(...remaining);
  }

  // ------------------------------------------------------ orchestrator ops

  /**
   * Orchestrator-driven: tear down one of THIS engine's live units
   * (Active → Unloading → Pending). Idempotently skipped when this engine's
   * scope died mid-transaction. `parkAsPending` is false for the unprovide
   * target itself (removal is not a state).
   */
  _teardownForCascade(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
    tornDown: string[],
    parkAsPending: boolean,
  ): void | Promise<void> {
    if (this._disposed || !this._host.isMaterialized(token)) {
      return undefined;
    }
    this._unitFor(token).state = 'Unloading';
    const out = this._host.retire(token);
    tornDown.push(this._label({ scope: this._scope, token }));
    if (parkAsPending) {
      // Dependents and replaced units go back to the waiting area with their
      // recipe retained; they were live, so they always rebuild.
      this._markPending(token, undefined, true);
    }
    return out;
  }

  /** Orchestrator-driven: recheck THIS engine's waiting area (transaction ⑤). */
  _recheckForCascade(rebuilt: string[], failed: string[]): void {
    if (this._disposed) {
      return;
    }
    this._recheckPending(rebuilt, failed);
  }

  /** Orchestrator-driven: apply THIS engine's own change (transaction ④). */
  _applyChangeForCascade(change: CascadeChange): void {
    if (this._disposed) {
      return;
    }
    switch (change.action) {
      case 'provide':
        if (change.descriptor !== undefined) {
          this._host.applyProvide(change.token, change.descriptor, change.pinned);
          this._markPending(change.token, change.activation ?? 'eager', false);
        } else {
          // Pre-materialized instance: a new generation that is already
          // live — no activation to schedule, dependents rebuild below.
          this._host.applyProvideInstance(change.token, change.instance, change.pinned);
          const unit = this._unitFor(change.token);
          unit.state = 'Active';
          unit.everActive = true;
          unit.error = undefined;
        }
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

  // ------------------------------------------------------------------ queue

  private _pump(): void {
    if (this._tree.running) {
      return;
    }
    const batch = this._tree.queue.splice(0);
    if (batch.length === 0) {
      return;
    }
    this._tree.running = true;
    const finish = (error?: unknown): void => {
      this._tree.running = false;
      for (const request of batch) {
        if (error === undefined) {
          request.resolve();
        } else {
          request.reject(error);
        }
      }
      this._tree.fireSettleWaiters();
      this._pump();
    };
    // The first request's engine orchestrates the merged transaction.
    const orchestrator = batch[0]!.engine;
    try {
      const out = orchestrator._transact(batch);
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

  private _transact(batch: QueuedRequest[]): void | Promise<void> {
    const changes = mergeBatch(batch);
    const started = this._options.now?.() ?? Date.now();
    const reason = changes.map(({ change }) => change.reason).join('; ');
    // ① contagion set from the tree-global graph (includes the changed tokens).
    const affected = this._tree.graph.affectedSet(
      changes.map(({ engine, change }) => ({ scope: engine._scope, token: change.token })),
    );
    for (const ref of affected) {
      this._tree.inFlightSet(ref, true);
    }
    this._tree.orchestrator = this._scope;
    const complete = (abort: { waited: boolean; timedOut: boolean }): void | Promise<void> => {
      const clear = (): void => {
        this._tree.inFlightClear(affected);
        this._tree.orchestrator = undefined;
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
    const wait = this._waitForAbort(affected, reason);
    if (isPromiseLike(wait)) {
      return Promise.resolve(wait).then(complete);
    }
    return complete(wait);
  }

  private _waitForAbort(
    affected: readonly ScopedToken[],
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
      Promise.resolve(out).then(
        () => ({ waited: true, timedOut: false }),
        (error: unknown) => {
          // Best-effort (§4.5): an async abort failure is logged, never a veto.
          onUnexpectedError(error);
          return { waited: true, timedOut: false };
        },
      ),
      new Promise<{ waited: boolean; timedOut: boolean }>((resolve) => {
        setTimeout(() => { resolve({ waited: true, timedOut: true }); }, waitMs);
      }),
    ]);
  }

  private _applyTransaction(
    changes: QueuedRequest[],
    affected: readonly ScopedToken[],
    reason: string,
    started: number,
    abort: { waited: boolean; timedOut: boolean },
  ): void | Promise<void> {
    const tornDown: string[] = [];
    const rebuilt: string[] = [];
    const failed: string[] = [];

    // ③ tear the contagion set down in global reverse topological order,
    // serially; each scope's engine executes its own units.
    const teardownOrder = this._tree.graph.reverseTopoOrder(affected);
    let index = 0;
    const step = (): void | Promise<void> => {
      while (index < teardownOrder.length) {
        const ref = teardownOrder[index]!;
        index += 1;
        const owner = engineOf(ref);
        if (owner === undefined || owner._disposed) {
          continue; // descendant scope died mid-transaction: skip idempotently
        }
        // The unprovide target itself is removed in ④, not parked as Pending.
        const removed = changes.some(
          ({ engine, change }) =>
            engine === owner && change.token === ref.token && change.action === 'unprovide',
        );
        const out = owner._teardownForCascade(ref.token, tornDown, !removed);
        if (isPromiseLike(out)) {
          return Promise.resolve(out).then(step);
        }
      }
      return undefined;
    };

    const after = (): void => {
      // ④ apply each change in its own scope.
      for (const { engine, change } of changes) {
        engine._applyChangeForCascade(change);
      }
      // ⑤ recheck the waiting area across the tree: every live engine, in
      // shallow-first order (dependencies only point upward, so depth order
      // is a valid global topological order across scopes), iterated to a
      // fixpoint — activating one unit may satisfy the next.
      const enginesInOrder = [...this._tree.engines]
        .filter((engine) => !engine._disposed)
        .sort((a, b) => a._scope.cascadeDepth - b._scope.cascadeDepth);
      for (;;) {
        let progress = false;
        for (const engine of enginesInOrder) {
          const before = rebuilt.length + failed.length;
          engine._recheckForCascade(rebuilt, failed);
          if (rebuilt.length + failed.length > before) {
            progress = true;
          }
        }
        if (!progress) {
          break;
        }
      }
      // ⑥ history ring (orchestrator-local).
      this._pushHistory({
        seq: ++this._historySeq,
        reason,
        changes: changes.map(({ engine, change }) => ({
          token: this._label({ scope: engine._scope, token: change.token }),
          action: change.action,
        })),
        affected: affected.map((ref) => this._label(ref)),
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
   * ⑤ for one engine: rebuild the missing-token index from scratch (cheap:
   * one sweep of the waiting area), then activate every satisfied unit in
   * topological order, iterating to a fixpoint. Satisfaction consults the
   * dependency's OWNING engine across scopes (D9).
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
      const ordered = this._tree.graph.topoOrder(
        satisfied.map((token) => ({ scope: this._scope, token })),
      );
      for (const ref of ordered) {
        this._activate(ref.token, rebuilt, failed);
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
      rebuilt.push(this._label({ scope: this._scope, token }));
    } catch (error) {
      // D5: Failed is sticky — no automatic retry; explicit update() reloads.
      unit.state = 'Failed';
      unit.error = error;
      failed.push(this._label({ scope: this._scope, token }));
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
    // The dependency's state is owned by the engine of the scope that
    // registered it (an ancestor's engine for a cross-scope injection).
    const owner = this._host.ownerScopeOf(dep);
    const engine = owner === undefined ? undefined : engineOf({ scope: owner, token: dep });
    const state = engine?.unitState(dep);
    return state === undefined || state === 'Active';
  }

  /** Render a scoped token for history: plain for the orchestrator's scope, `#n:token` for others. */
  private _label(ref: ScopedToken): string {
    if (ref.scope === this._tree.orchestrator) {
      return ref.token.toString();
    }
    return `#${this._tree.seqOf(ref.scope)}:${ref.token.toString()}`;
  }

  /** Merge-queue dedupe key for this engine's scope. */
  _mergeKey(): string {
    return String(this._tree.seqOf(this._scope));
  }

  private _pushHistory(entry: CascadeHistoryEntry): void {
    this._history.push(entry);
    const capacity = this._options.historyCapacity ?? DEFAULT_HISTORY_CAPACITY;
    if (this._history.length > capacity) {
      this._history.splice(0, this._history.length - capacity);
    }
  }
}

/** Resolve a scoped token to its scope's engine (structural handle). */
function engineOf(ref: ScopedToken): CascadeEngine | undefined {
  return (ref.scope as Partial<CascadeScopeHandle>).cascade;
}

/** Queued requests merge: one change per scope+token (latest wins), order preserved. */
function mergeBatch(batch: QueuedRequest[]): QueuedRequest[] {
  const byKey = new Map<string, QueuedRequest>();
  for (const request of batch) {
    const key = `${request.engine._mergeKey()}:${request.change.token.toString()}`;
    byKey.set(key, request);
  }
  return [...byKey.values()];
}
