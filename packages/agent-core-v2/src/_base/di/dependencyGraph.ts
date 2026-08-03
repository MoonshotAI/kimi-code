/**
 * `di` domain — persistent dependency graph (L2 substrate).
 *
 * Edges are recorded when a service's constructor dependencies are resolved
 * and removed when the consumer is torn down, so the graph always mirrors the
 * live container. Instance edges bind a consumer to its dependency's
 * generation (the dependency changes → the consumer is torn down and rebuilt);
 * collection edges (Phase 3) are recorded for introspection but never join a
 * cascade contagion set.
 */

import type { ServiceIdentifier } from './instantiation';

export type DependencyEdgeKind = 'instance' | 'collection';

export interface DependencyEdge {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly consumer: ServiceIdentifier<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly dependency: ServiceIdentifier<any>;
  readonly kind: DependencyEdgeKind;
}

export class DependencyGraph {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _tokenByInstance = new Map<object, ServiceIdentifier<any>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _instanceByToken = new Map<ServiceIdentifier<any>, object>();
  /** consumer instance → (dependency token → edge kind) */
  private readonly _out = new Map<object, Map<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ServiceIdentifier<any>,
    DependencyEdgeKind
  >>();
  /** dependency token → (consumer instance → edge kind) */
  private readonly _in = new Map<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ServiceIdentifier<any>,
    Map<object, DependencyEdgeKind>
  >();

  /** Register a materialized service instance so its edges can be tracked. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addInstance(instance: object, token: ServiceIdentifier<any>): void {
    this._tokenByInstance.set(instance, token);
    this._instanceByToken.set(token, instance);
  }

  /** Drop a consumer: its outbound edges and token mapping (inbound token edges stay). */
  removeInstance(instance: object): void {
    const token = this._tokenByInstance.get(instance);
    if (token !== undefined) {
      this._tokenByInstance.delete(instance);
      if (this._instanceByToken.get(token) === instance) {
        this._instanceByToken.delete(token);
      }
    }
    const out = this._out.get(instance);
    if (out !== undefined) {
      for (const dependency of out.keys()) {
        this._in.get(dependency)?.delete(instance);
      }
      this._out.delete(instance);
    }
  }

  addEdge(
    consumerInstance: object,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dependency: ServiceIdentifier<any>,
    kind: DependencyEdgeKind = 'instance',
  ): void {
    let out = this._out.get(consumerInstance);
    if (out === undefined) {
      out = new Map();
      this._out.set(consumerInstance, out);
    }
    out.set(dependency, kind);

    let inbound = this._in.get(dependency);
    if (inbound === undefined) {
      inbound = new Map();
      this._in.set(dependency, inbound);
    }
    inbound.set(consumerInstance, kind);
  }

  /**
   * The contagion set: the changed tokens plus every token whose live instance
   * transitively depends on them through instance edges.
   */
  affectedSet(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    changed: Iterable<ServiceIdentifier<any>>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Set<ServiceIdentifier<any>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const affected = new Set<ServiceIdentifier<any>>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queue: ServiceIdentifier<any>[] = [];
    for (const token of changed) {
      if (!affected.has(token)) {
        affected.add(token);
        queue.push(token);
      }
    }
    while (queue.length > 0) {
      const token = queue.pop()!;
      const inbound = this._in.get(token);
      if (inbound === undefined) continue;
      for (const [consumerInstance, kind] of inbound) {
        if (kind !== 'instance') continue;
        const consumerToken = this._tokenByInstance.get(consumerInstance);
        if (consumerToken === undefined || affected.has(consumerToken)) continue;
        affected.add(consumerToken);
        queue.push(consumerToken);
      }
    }
    return affected;
  }

  /** Dependencies-first order over the given token subset (instance edges only). */
  topoOrder(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tokens: Iterable<ServiceIdentifier<any>>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): ServiceIdentifier<any>[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subset = new Set<ServiceIdentifier<any>>(tokens);
    // token → in-subset dependencies
    const dependencies = new Map<
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ServiceIdentifier<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Set<ServiceIdentifier<any>>
    >();
    for (const token of subset) {
      dependencies.set(token, this._dependenciesOf(token, subset));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ordered: ServiceIdentifier<any>[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const permanent = new Set<ServiceIdentifier<any>>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visit = (token: ServiceIdentifier<any>): void => {
      if (permanent.has(token)) return;
      permanent.add(token);
      for (const dependency of dependencies.get(token) ?? []) {
        visit(dependency);
      }
      ordered.push(token);
    };
    for (const token of subset) {
      visit(token);
    }
    return ordered;
  }

  /** Dependents-first order (teardown order) over the given token subset. */
  reverseTopoOrder(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tokens: Iterable<ServiceIdentifier<any>>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): ServiceIdentifier<any>[] {
    return this.topoOrder(tokens).toReversed();
  }

  /** Instance-edge cycle check over the live graph; returns the cycle path or null. */
  findCycle(): string[] | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = new Map<ServiceIdentifier<any>, 'visiting' | 'done'>();
    const path: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visit = (token: ServiceIdentifier<any>): string[] | null => {
      state.set(token, 'visiting');
      path.push(token.toString());
      for (const dependency of this._dependenciesOf(token, undefined)) {
        const mark = state.get(dependency);
        if (mark === 'done') continue;
        if (mark === 'visiting') {
          const start = path.indexOf(dependency.toString());
          return [...path.slice(start), dependency.toString()];
        }
        const cycle = visit(dependency);
        if (cycle !== null) return cycle;
      }
      path.pop();
      state.set(token, 'done');
      return null;
    };
    for (const token of this._instanceByToken.keys()) {
      if (state.has(token)) continue;
      const cycle = visit(token);
      if (cycle !== null) return cycle;
    }
    return null;
  }

  /** Introspection: every live edge (both kinds), token-level. */
  edges(): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    for (const [consumerInstance, out] of this._out) {
      const consumer = this._tokenByInstance.get(consumerInstance);
      if (consumer === undefined) continue;
      for (const [dependency, kind] of out) {
        edges.push({ consumer, dependency, kind });
      }
    }
    return edges;
  }

  clear(): void {
    this._tokenByInstance.clear();
    this._instanceByToken.clear();
    this._out.clear();
    this._in.clear();
  }

  /** In-subset instance-edge dependencies of a token's live instance. */
  private _dependenciesOf(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: ServiceIdentifier<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subset: Set<ServiceIdentifier<any>> | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Set<ServiceIdentifier<any>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = new Set<ServiceIdentifier<any>>();
    const instance = this._instanceByToken.get(token);
    if (instance === undefined) return result;
    const out = this._out.get(instance);
    if (out === undefined) return result;
    for (const [dependency, kind] of out) {
      if (kind !== 'instance') continue;
      if (subset !== undefined && !subset.has(dependency)) continue;
      result.add(dependency);
    }
    return result;
  }
}
