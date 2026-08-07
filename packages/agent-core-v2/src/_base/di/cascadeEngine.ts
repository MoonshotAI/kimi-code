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
import { Emitter, type Event } from '../event';
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

export type UnitActivation = 'eager' | 'ondemand';

export interface CascadeChange {
  readonly action: CascadeAction;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly token: ServiceIdentifier<any>;
  readonly descriptor?: SyncDescriptor<unknown>;
  readonly instance?: unknown;
  readonly activation?: UnitActivation;
  readonly config?: unknown;
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

export interface UnitSnapshot {
  readonly token: string;
  readonly state: UnitState;
  readonly error?: string;
  readonly everActive: boolean;
  readonly inFlight: boolean;
}

export interface UnitStateChange {
  readonly token: string;
  readonly state: UnitState;
  readonly error?: string;
}

export interface CascadeEngineOptions {
  onWillCascade?: (
    affected: readonly ScopedToken[],
    reason: string,
  ) => void | Promise<void>;
  readonly abortWaitMs?: number;
  readonly resolveTimeoutMs?: number;
  readonly historyCapacity?: number;
  readonly now?: () => number;
}

export interface CascadeHost {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isRegistered(token: ServiceIdentifier<any>): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ownerScopeOf(token: ServiceIdentifier<any>): object | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isMaterialized(token: ServiceIdentifier<any>): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  materialize(token: ServiceIdentifier<any>): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retire(token: ServiceIdentifier<any>): void | Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyProvide(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
    descriptor: SyncDescriptor<unknown>,
    config: unknown,
  ): number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyProvideInstance(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
    instance: unknown,
    config: unknown,
  ): number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyUnprovide(token: ServiceIdentifier<any>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recipeOf(token: ServiceIdentifier<any>): SyncDescriptor<unknown> | undefined;
  dependenciesOf(
    recipe: SyncDescriptor<unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Array<ServiceIdentifier<any>>;
}

export interface CascadeScopeHandle {
  readonly cascade: CascadeEngine;
  readonly cascadeDisposed: boolean;
  readonly cascadeDepth: number;
}

interface UnitRecord {
  state: UnitState;
  error?: unknown;
  activation: UnitActivation;
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

export class CascadeTree {
  readonly graph: DependencyGraph;
  readonly queue: QueuedRequest[] = [];
  readonly engines = new Set<CascadeEngine>();
  running = false;
  orchestrator: object | undefined;
  private readonly _inFlight = new PairIndex<true>();
  private _settleWaiters: Array<() => void> = [];
  private readonly _scopeSeq = new Map<object, number>();
  private _nextScopeSeq = 0;
  private readonly _onDidAddEngine = new Emitter<CascadeEngine>();
  readonly onDidAddEngine: Event<CascadeEngine> = this._onDidAddEngine.event;
  private readonly _onDidRemoveEngine = new Emitter<CascadeEngine>();
  readonly onDidRemoveEngine: Event<CascadeEngine> = this._onDidRemoveEngine.event;

  constructor(graph: DependencyGraph) {
    this.graph = graph;
  }

  addEngine(engine: CascadeEngine): void {
    this.engines.add(engine);
    this._onDidAddEngine.fire(engine);
  }

  removeEngine(engine: CascadeEngine): void {
    if (this.engines.delete(engine)) {
      this._onDidRemoveEngine.fire(engine);
    }
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
  private readonly _pendingIndex = new Map<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ServiceIdentifier<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Set<ServiceIdentifier<any>>
  >();
  private readonly _history: CascadeHistoryEntry[] = [];
  private _historySeq = 0;
  private _disposed = false;
  private readonly _onDidChangeUnitState = new Emitter<UnitStateChange>();
  readonly onDidChangeUnitState: Event<UnitStateChange> = this._onDidChangeUnitState.event;
  private readonly _onDidCascade = new Emitter<CascadeHistoryEntry>();
  readonly onDidCascade: Event<CascadeHistoryEntry> = this._onDidCascade.event;

  constructor(
    private readonly _host: CascadeHost,
    private readonly _scope: CascadeScopeHandle,
    private readonly _tree: CascadeTree,
    private _options: CascadeEngineOptions = {},
  ) {
    this._tree.addEngine(this);
  }

  configure(options: CascadeEngineOptions): void {
    this._options = { ...this._options, ...options };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stateOf(token: ServiceIdentifier<any>): UnitState | undefined {
    return this._units.get(token)?.state;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activationOf(token: ServiceIdentifier<any>): UnitActivation | undefined {
    return this._units.get(token)?.activation;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  materializable(token: ServiceIdentifier<any>): boolean {
    return this._host.recipeOf(token) !== undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  failureOf(token: ServiceIdentifier<any>): unknown {
    const unit = this._units.get(token);
    return unit?.state === 'Failed' ? unit.error : undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isInFlight(token: ServiceIdentifier<any>): boolean {
    const owner = this._host.ownerScopeOf(token) ?? this._scope;
    return this._tree.inFlightHas({ scope: owner, token });
  }

  history(): readonly CascadeHistoryEntry[] {
    return this._history;
  }

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

  unitsSnapshot(): UnitSnapshot[] {
    const snapshot: UnitSnapshot[] = [];
    for (const [token, unit] of this._units) {
      snapshot.push({
        token: token.toString(),
        state: unit.state,
        error: unit.error === undefined ? undefined : serializeError(unit.error),
        everActive: unit.everActive,
        inFlight: this.isInFlight(token),
      });
    }
    return snapshot;
  }

  submit(change: CascadeChange): Promise<void> {
    if (this._disposed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this._tree.queue.push({ engine: this, change, resolve, reject });
      this._pump();
    });
  }

  submitAll(changes: readonly CascadeChange[]): Promise<void> {
    if (this._disposed || changes.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      for (const change of changes) {
        this._tree.queue.push({ engine: this, change, resolve, reject });
      }
      this._pump();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(token: ServiceIdentifier<any>, reason?: string): Promise<void> {
    return this.submit({
      action: 'update',
      token,
      reason: reason ?? `update ${String(token)}`,
    });
  }

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  observedMaterialization(token: ServiceIdentifier<any>): void {
    const unit = this._units.get(token);
    if (unit !== undefined && unit.state === 'Pending') {
      unit.everActive = true;
      this._setUnitState(token, unit, 'Active', undefined);
    }
  }

  dispose(): void {
    this._disposed = true;
    this._tree.removeEngine(this);
    this._units.clear();
    this._pendingIndex.clear();
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
    this._onDidChangeUnitState.dispose();
    this._onDidCascade.dispose();
  }


  _teardownForCascade(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
    tornDown: string[],
    parkAsPending: boolean,
  ): void | Promise<void> {
    if (this._disposed || !this._host.isMaterialized(token)) {
      return undefined;
    }
    this._setUnitState(token, this._unitFor(token), 'Unloading', undefined);
    const out = this._host.retire(token);
    tornDown.push(this._label({ scope: this._scope, token }));
    if (parkAsPending) {
      this._markPending(token, undefined, true);
    }
    return out;
  }

  _recheckForCascade(rebuilt: string[], failed: string[]): void {
    if (this._disposed) {
      return;
    }
    this._recheckPending(rebuilt, failed);
  }

  _applyChangeForCascade(change: CascadeChange): void {
    if (this._disposed) {
      return;
    }
    switch (change.action) {
      case 'provide':
        if (change.descriptor !== undefined) {
          this._host.applyProvide(change.token, change.descriptor, change.config);
          this._markPending(change.token, change.activation ?? 'eager', false);
        } else {
          this._host.applyProvideInstance(change.token, change.instance, change.config);
          const unit = this._unitFor(change.token);
          unit.everActive = true;
          this._setUnitState(change.token, unit, 'Active', undefined);
        }
        break;
      case 'unprovide':
        this._host.applyUnprovide(change.token);
        this._units.delete(change.token);
        break;
      case 'update':
        this._markPending(change.token, undefined, true);
        break;
    }
  }


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


  private _transact(batch: QueuedRequest[]): void | Promise<void> {
    const changes = mergeBatch(batch);
    const started = this._options.now?.() ?? Date.now();
    const reason = changes.map(({ change }) => change.reason).join('; ');
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
        return Promise.resolve(out).then(clear, (error: unknown) => {
          clear();
          throw error;
        });
      }
      clear();
      return undefined;
    };
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

    const teardownOrder = this._tree.graph.reverseTopoOrder(affected);
    let index = 0;
    const step = (): void | Promise<void> => {
      while (index < teardownOrder.length) {
        const ref = teardownOrder[index]!;
        index += 1;
        const owner = engineOf(ref);
        if (owner === undefined || owner._disposed) {
          continue;
        }
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
      for (const { engine, change } of changes) {
        engine._applyChangeForCascade(change);
      }
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


  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _unitFor(token: ServiceIdentifier<any>): UnitRecord {
    let unit = this._units.get(token);
    if (unit === undefined) {
      unit = { state: 'Pending', activation: 'eager', everActive: false };
      this._units.set(token, unit);
      this._onDidChangeUnitState.fire({ token: token.toString(), state: 'Pending' });
    }
    return unit;
  }

  private _setUnitState(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
    unit: UnitRecord,
    state: UnitState,
    error: unknown,
  ): void {
    const changed = unit.state !== state;
    unit.state = state;
    unit.error = error;
    if (changed) {
      this._onDidChangeUnitState.fire({
        token: token.toString(),
        state,
        error: error === undefined ? undefined : serializeError(error),
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _markPending(
    token: ServiceIdentifier<any>,
    activation?: UnitActivation,
    everActive?: boolean,
  ): void {
    const unit = this._unitFor(token);
    this._setUnitState(token, unit, 'Pending', undefined);
    if (activation !== undefined) {
      unit.activation = activation;
    }
    if (everActive !== undefined) {
      unit.everActive = everActive;
    }
  }

  private _recheckPending(rebuilt: string[], failed: string[]): void {
    for (;;) {
      this._pendingIndex.clear();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const satisfied: ServiceIdentifier<any>[] = [];
      for (const [token, unit] of this._units) {
        if (unit.state !== 'Pending') continue;
        const missing = this._missingDeps(token);
        if (missing.length === 0) {
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
      for (const [token, unit] of this._units) {
        if (
          (unit.state === 'Pending' || unit.state === 'Activating') &&
          this._host.isMaterialized(token)
        ) {
          unit.everActive = true;
          this._setUnitState(token, unit, 'Active', undefined);
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _activate(token: ServiceIdentifier<any>, rebuilt: string[], failed: string[]): void {
    const unit = this._unitFor(token);
    this._setUnitState(token, unit, 'Activating', undefined);
    try {
      this._host.materialize(token);
      unit.everActive = true;
      this._setUnitState(token, unit, 'Active', undefined);
      rebuilt.push(this._label({ scope: this._scope, token }));
    } catch (error) {
      this._setUnitState(token, unit, 'Failed', error);
      failed.push(this._label({ scope: this._scope, token }));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _missingDeps(token: ServiceIdentifier<any>): Array<ServiceIdentifier<any>> {
    const recipe = this._host.recipeOf(token);
    if (recipe === undefined) {
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
    const owner = this._host.ownerScopeOf(dep);
    const engine = owner === undefined ? undefined : engineOf({ scope: owner, token: dep });
    const state = engine?.stateOf(dep);
    if (state === undefined || state === 'Active') {
      return true;
    }
    return (
      state === 'Pending' &&
      engine !== undefined &&
      engine.activationOf(dep) === 'ondemand' &&
      engine.materializable(dep)
    );
  }

  private _label(ref: ScopedToken): string {
    if (ref.scope === this._tree.orchestrator) {
      return ref.token.toString();
    }
    return `#${this._tree.seqOf(ref.scope)}:${ref.token.toString()}`;
  }

  _mergeKey(): string {
    return String(this._tree.seqOf(this._scope));
  }

  private _pushHistory(entry: CascadeHistoryEntry): void {
    this._history.push(entry);
    const capacity = this._options.historyCapacity ?? DEFAULT_HISTORY_CAPACITY;
    if (this._history.length > capacity) {
      this._history.splice(0, this._history.length - capacity);
    }
    this._onDidCascade.fire(entry);
  }
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function engineOf(ref: ScopedToken): CascadeEngine | undefined {
  return (ref.scope as Partial<CascadeScopeHandle>).cascade;
}

function mergeBatch(batch: QueuedRequest[]): QueuedRequest[] {
  const byKey = new Map<string, QueuedRequest>();
  for (const request of batch) {
    const key = `${request.engine._mergeKey()}:${request.change.token.toString()}`;
    byKey.set(key, request);
  }
  return [...byKey.values()];
}
