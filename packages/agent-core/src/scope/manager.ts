/**
 * Manager service pattern for the di-v3 scope mechanism.
 *
 * Normative source:
 * `.agents/skills/service-skill/explanation/scope-mechanism.md`
 * (`Manager 上行流（主动 attach 订阅）`, `dispose() 流 + manager onDid* 配对`,
 * invariant 12).
 *
 * A manager service:
 *
 * - lives in the **parent** scope of the scope it manages;
 * - is the **sole up-going event publisher** for its child scopes;
 * - attaches to a child's per-scope event source via `child.accessor.get(...)`
 *   and re-emits collection-view events that add the child id;
 * - pairs `dispose()` with an `onDid*` fire + `eventBus.publish(...)` in a
 *   `try/finally` so teardown always completes (invariant 12);
 * - never exposes its write methods to child-scope services — children receive
 *   only their own scope handle and accessor, never a handle back to the
 *   manager, so a child cannot reverse-call into the manager.
 *
 * This module ships the generic {@link ScopeManager} base class, which captures
 * the enforceable parts of the pattern (the single child-tracking map plus the
 * dispose pairing). Real domain managers (AgentLifecycleService, TurnService,
 * ...) land in later phases per domain; here we only provide the base plus a
 * test double (see `test/scope/manager.test.ts`).
 */

import { Emitter, type Event } from '../base/common/event';
import type { IScopeHandle } from './handle';

/**
 * Event fired by a manager after a child scope has finished disposing. At that
 * point the child's scoped services are already gone, so listeners must only
 * update their own state and must not resolve child services.
 */
export interface IChildLifecycleEvent {
  readonly childId: string;
  readonly reason?: string;
}

/**
 * Minimal event-bus port a manager publishes lifecycle events to.
 *
 * Kept generic and decoupled from the concrete `IDomainEventBus` (which is
 * coupled to the rpc `AgentEvent` shape) so the scope mechanism does not depend
 * on that bus, and so tests can supply a recording fake. A real domain manager
 * wires this to whatever bus its scope owns.
 */
export interface IManagerEventBus<TPublish> {
  publish(event: TPublish): void;
}

/**
 * Contract for a manager service managing child scopes of type `TChild`.
 *
 * The manager's write methods ({@link IManagerService.disposeChild} plus the
 * subclass's create/add methods) are NOT exposed to child-scope services: a
 * child only ever sees its own {@link IScopeHandle} and `accessor`, never the
 * manager. This is enforced by the contract — there is no API surface here
 * that a child could call back into.
 */
export interface IManagerService<TChild extends IScopeHandle> {
  /** Fires after a child scope has been disposed (its data is already gone). */
  readonly onDidChildDispose: Event<IChildLifecycleEvent>;
  /** Read-only view of the children currently tracked by this manager. */
  readonly children: ReadonlyMap<string, TChild>;
  /** True if a child with `childId` is currently tracked. */
  hasChild(childId: string): boolean;
  /**
   * Disposes a tracked child and pairs the teardown with `onDidChildDispose`
   * + `eventBus.publish` in a `try/finally` (invariant 12). No-op when the
   * child is unknown.
   */
  disposeChild(childId: string, reason?: string): Promise<void>;
}

/**
 * Generic base class for a manager service. Captures the enforceable parts of
 * the manager pattern:
 *
 * - the single allowed `Map<childId, TChild>` of tracked child handles;
 * - the {@link ScopeManager.disposeChild} `try/finally` that always drops the
 *   child, fires `onDidChildDispose`, and publishes to the bus — even when
 *   `child.dispose()` rejects;
 * - protected hooks ({@link ScopeManager.trackChild}, {@link ScopeManager.getChild},
 *   {@link ScopeManager.publish}) subclasses use to register children, attach
 *   to their event sources, and re-emit collection-view events.
 *
 * Subclasses implement {@link ScopeManager.buildDisposeEvent} to map a child
 * dispose into the concrete bus event shape. The base guarantees that event is
 * published in the `finally` block of {@link ScopeManager.disposeChild}.
 */
export abstract class ScopeManager<
  TChild extends IScopeHandle,
  TPublish = unknown,
> implements IManagerService<TChild> {
  private readonly _children = new Map<string, TChild>();
  private readonly _onDidChildDispose = new Emitter<IChildLifecycleEvent>();

  readonly onDidChildDispose: Event<IChildLifecycleEvent> =
    this._onDidChildDispose.event;

  constructor(private readonly eventBus: IManagerEventBus<TPublish>) {}

  /** Read-only view of the tracked children (`Map<childId, TChild>`). */
  get children(): ReadonlyMap<string, TChild> {
    return this._children;
  }

  hasChild(childId: string): boolean {
    return this._children.has(childId);
  }

  /**
   * Register a child handle under its `id`. Subclasses call this after building
   * the child scope and attaching to its event sources.
   */
  protected trackChild(child: TChild): void {
    this._children.set(child.id, child);
  }

  /** Look up a tracked child by id (subclass-only). */
  protected getChild(childId: string): TChild | undefined {
    return this._children.get(childId);
  }

  /**
   * Publish a bus event (subclass-only). Used both for re-emitted
   * collection-view events and, indirectly, for the dispose event.
   */
  protected publish(event: TPublish): void {
    this.eventBus.publish(event);
  }

  /**
   * Disposes a tracked child and pairs the teardown with `onDidChildDispose`
   * + `eventBus.publish` in a `try/finally`. No-op when the child is unknown.
   *
   * Invariant 12: even if `child.dispose()` rejects, the manager still drops
   * the child, fires `onDidChildDispose`, and publishes the bus event. The
   * rejection is re-thrown after the `finally` block runs, matching the
   * scope-mechanism contract.
   */
  async disposeChild(childId: string, reason?: string): Promise<void> {
    const child = this._children.get(childId);
    if (child === undefined) {
      return;
    }
    try {
      await child.dispose(reason);
    } finally {
      this._children.delete(childId);
      this._onDidChildDispose.fire({ childId, reason });
      this.eventBus.publish(this.buildDisposeEvent(childId, reason));
    }
  }

  /**
   * Map a child dispose into the bus event the manager publishes. Subclasses
   * define the concrete shape; the base guarantees it is published in the
   * `finally` block of {@link ScopeManager.disposeChild}.
   */
  protected abstract buildDisposeEvent(
    childId: string,
    reason?: string,
  ): TPublish;

  /** Tears down the manager's own emitters and drops every tracked child. */
  dispose(): void {
    this._onDidChildDispose.dispose();
    this._children.clear();
  }
}
