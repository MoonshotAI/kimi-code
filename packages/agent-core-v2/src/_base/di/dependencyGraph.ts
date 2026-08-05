/**
 * `di` domain — persistent dependency graph (L2 substrate), tree-global.
 *
 * One graph is shared by every container of a scope tree. Edges are recorded
 * when a service's constructor dependencies are resolved and removed when the
 * consumer is torn down, so the graph always mirrors the live containers.
 * Both ends of an edge are scope-tagged: a consumer in a child scope may bind
 * a token owned by an ancestor scope (child → parent only — a parent can never
 * resolve a child's token, so cross-tree cycles are impossible by
 * construction). Instance edges bind a consumer to its dependency's
 * generation (the dependency changes → the consumer is torn down and rebuilt,
 * across scopes); collection edges (Phase 3) are recorded for introspection
 * but never join a cascade contagion set.
 */

import type { ServiceIdentifier } from './instantiation';

/** A token as seen from the tree: the owning container plus the identifier. */
export interface ScopedToken {
  /** The container whose collection owns the registration. */
  readonly scope: object;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly token: ServiceIdentifier<any>;
}

export type DependencyEdgeKind = 'instance' | 'collection';

export interface DependencyEdge {
  readonly consumer: ScopedToken;
  readonly dependency: ScopedToken;
  readonly kind: DependencyEdgeKind;
}

/** Nested scope → token maps, so scoped tokens stay structural (no interning). */
export class PairIndex<V> {
  private readonly _map = new Map<object, Map<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ServiceIdentifier<any>,
    V
  >>();

  get(scope: object, token: ServiceIdentifier<unknown>): V | undefined {
    return this._map.get(scope)?.get(token);
  }

  set(scope: object, token: ServiceIdentifier<unknown>, value: V): void {
    let inner = this._map.get(scope);
    if (inner === undefined) {
      inner = new Map();
      this._map.set(scope, inner);
    }
    inner.set(token, value);
  }

  delete(scope: object, token: ServiceIdentifier<unknown>): void {
    const inner = this._map.get(scope);
    if (inner === undefined) return;
    inner.delete(token);
    if (inner.size === 0) {
      this._map.delete(scope);
    }
  }

  entries(): Array<[ScopedToken, V]> {
    const out: Array<[ScopedToken, V]> = [];
    for (const [scope, inner] of this._map) {
      for (const [token, value] of inner) {
        out.push([{ scope, token }, value]);
      }
    }
    return out;
  }

  clear(): void {
    this._map.clear();
  }
}

export class DependencyGraph {
  /** live instance → its scoped token */
  private readonly _refByInstance = new Map<object, ScopedToken>();
  /** scoped token → live instance */
  private readonly _instanceByRef = new PairIndex<object>();
  /** consumer instance → (dependency scoped token → edge kind) */
  private readonly _out = new Map<object, PairIndex<DependencyEdgeKind>>();
  /** dependency scoped token → (consumer instance → edge kind) */
  private readonly _in = new PairIndex<Map<object, DependencyEdgeKind>>();

  /** Register a materialized service instance so its edges can be tracked. */
  addInstance(
    instance: object,
    scope: object,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
  ): void {
    const ref: ScopedToken = { scope, token };
    this._refByInstance.set(instance, ref);
    this._instanceByRef.set(scope, token, instance);
  }

  /** Drop a consumer: its outbound edges and token mapping (inbound edges stay). */
  removeInstance(instance: object): void {
    const ref = this._refByInstance.get(instance);
    if (ref !== undefined) {
      this._refByInstance.delete(instance);
      if (this._instanceByRef.get(ref.scope, ref.token) === instance) {
        this._instanceByRef.delete(ref.scope, ref.token);
      }
    }
    const out = this._out.get(instance);
    if (out !== undefined) {
      for (const [dependency] of out.entries()) {
        this._in.get(dependency.scope, dependency.token)?.delete(instance);
      }
      this._out.delete(instance);
    }
  }

  addEdge(
    consumerInstance: object,
    dependency: ScopedToken,
    kind: DependencyEdgeKind = 'instance',
  ): void {
    let out = this._out.get(consumerInstance);
    if (out === undefined) {
      out = new PairIndex();
      this._out.set(consumerInstance, out);
    }
    out.set(dependency.scope, dependency.token, kind);

    let inbound = this._in.get(dependency.scope, dependency.token);
    if (inbound === undefined) {
      inbound = new Map();
      this._in.set(dependency.scope, dependency.token, inbound);
    }
    inbound.set(consumerInstance, kind);
  }

  /**
   * The contagion set: the changed scoped tokens plus every scoped token whose
   * live instance transitively depends on them through instance edges —
   * computed across the whole tree (dependents always live in the changed
   * scope's subtree, since edges point child → parent).
   */
  affectedSet(changed: Iterable<ScopedToken>): ScopedToken[] {
    const seen = new PairIndex<true>();
    const queue: ScopedToken[] = [];
    const push = (ref: ScopedToken): void => {
      if (seen.get(ref.scope, ref.token) !== undefined) return;
      seen.set(ref.scope, ref.token, true);
      queue.push(ref);
    };
    for (const ref of changed) {
      push(ref);
    }
    const affected: ScopedToken[] = [];
    while (queue.length > 0) {
      const ref = queue.pop()!;
      affected.push(ref);
      const inbound = this._in.get(ref.scope, ref.token);
      if (inbound === undefined) continue;
      for (const [consumerInstance, kind] of inbound) {
        if (kind !== 'instance') continue;
        const consumer = this._refByInstance.get(consumerInstance);
        if (consumer === undefined) continue;
        push(consumer);
      }
    }
    return affected;
  }

  /** Dependencies-first order over the given scoped-token subset (instance edges). */
  topoOrder(tokens: Iterable<ScopedToken>): ScopedToken[] {
    const subset = new PairIndex<ScopedToken>();
    for (const ref of tokens) {
      subset.set(ref.scope, ref.token, ref);
    }
    const ordered: ScopedToken[] = [];
    const done = new PairIndex<true>();
    const visit = (ref: ScopedToken): void => {
      if (done.get(ref.scope, ref.token) !== undefined) return;
      done.set(ref.scope, ref.token, true);
      for (const dependency of this._dependenciesOf(ref, subset)) {
        visit(dependency);
      }
      ordered.push(ref);
    };
    for (const [, ref] of subset.entries()) {
      visit(ref);
    }
    return ordered;
  }

  /** Dependents-first order (teardown order) over the given scoped-token subset. */
  reverseTopoOrder(tokens: Iterable<ScopedToken>): ScopedToken[] {
    return this.topoOrder(tokens).toReversed();
  }

  /** Instance-edge cycle check over the live graph; returns the cycle path or null. */
  findCycle(label: (ref: ScopedToken) => string): string[] | null {
    const state = new PairIndex<'visiting' | 'done'>();
    const path: ScopedToken[] = [];
    const visit = (ref: ScopedToken): string[] | null => {
      state.set(ref.scope, ref.token, 'visiting');
      path.push(ref);
      for (const dependency of this._dependenciesOf(ref, undefined)) {
        const mark = state.get(dependency.scope, dependency.token);
        if (mark === 'done') continue;
        if (mark === 'visiting') {
          const start = path.findIndex(
            (entry) =>
              entry.scope === dependency.scope && entry.token === dependency.token,
          );
          return [...path.slice(start), dependency].map(label);
        }
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      }
      path.pop();
      state.set(ref.scope, ref.token, 'done');
      return null;
    };
    for (const [ref] of this._instanceByRef.entries()) {
      if (state.get(ref.scope, ref.token) !== undefined) continue;
      const cycle = visit(ref);
      if (cycle !== null) return cycle;
    }
    return null;
  }

  /** Introspection: every live edge (both kinds), scoped on both ends. */
  edges(): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    for (const [consumerInstance, out] of this._out) {
      const consumer = this._refByInstance.get(consumerInstance);
      if (consumer === undefined) continue;
      for (const [dependency, kind] of out.entries()) {
        edges.push({ consumer, dependency, kind });
      }
    }
    return edges;
  }

  clear(): void {
    this._refByInstance.clear();
    this._instanceByRef.clear();
    this._out.clear();
    this._in.clear();
  }

  /** In-subset instance-edge dependencies of a scoped token's live instance. */
  private _dependenciesOf(
    ref: ScopedToken,
    subset: PairIndex<ScopedToken> | undefined,
  ): ScopedToken[] {
    const instance = this._instanceByRef.get(ref.scope, ref.token);
    if (instance === undefined) return [];
    const out = this._out.get(instance);
    if (out === undefined) return [];
    const result: ScopedToken[] = [];
    for (const [dependency, kind] of out.entries()) {
      if (kind !== 'instance') continue;
      if (subset !== undefined && subset.get(dependency.scope, dependency.token) === undefined) {
        continue;
      }
      result.push(dependency);
    }
    return result;
  }
}
