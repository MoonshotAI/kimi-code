/**
 * Scope builders for the di-v3 scope mechanism.
 *
 * Normative source:
 * `.agents/skills/service-skill/explanation/scope-mechanism.md`
 * (`ScopeBuilder` 4-step pipeline).
 *
 * Each scope (`Session` / `Agent` / `Turn`) is built by the same 4-step
 * pipeline:
 *
 * 1. **Inject the scope identity context** into a fresh `ServiceCollection`
 *    (e.g. `collection.set(ISessionContext, context)`), so in-scope services
 *    can `@ISessionContext` their identity instead of receiving raw ids.
 * 2. **Install Pattern-1 statically registered services** — read
 *    `getScopedServiceDescriptors(scope)` and add each `(id, SyncDescriptor)`
 *    to the collection. Descriptors are lazy: nothing is instantiated until
 *    the first `accessor.get(id)`.
 * 3. **Reserved build hook (Pattern 2)** — NOT enabled in this version; a
 *    clearly marked no-op so Pattern 2 can be added later without touching
 *    Pattern-1 callers.
 * 4. **Reserved post-build interceptor (Pattern 3)** — NOT enabled in this
 *    version; same reasoning as step 3.
 *
 * Then `parent.createChild(collection)` produces the child container and the
 * returned {@link IScopeHandle} wraps it. `markBuilt()` is called on the first
 * build only — afterwards the registry rejects further registrations (the
 * already-built collection will not re-read it).
 */

import type { IInstantiationService, ServiceIdentifier } from '../di/instantiation';
import { ServiceCollection } from '../di/serviceCollection';
import { IAgentContext } from './context/agentContext';
import { ISessionContext } from './context/sessionContext';
import { ITurnContext } from './context/turnContext';
import { type IScopeHandle, ScopeHandle } from './handle';
import { LifecycleScope } from './lifecycle';
import { getScopedServiceDescriptors, isBuilt, markBuilt } from './registry';

/** Minimal shape every scope identity context must satisfy for the builder. */
export interface ScopeIdentityContext {
  readonly id: string;
}

/**
 * Generic 4-step scope builder, parameterized by the lifecycle scope and the
 * identity context it injects. The concrete builders below fix those two
 * parameters; subclasses / future patterns only need to override the reserved
 * hook methods.
 */
export class ScopeBuilder<TContext extends ScopeIdentityContext> {
  constructor(
    private readonly scope: LifecycleScope,
    private readonly contextId: ServiceIdentifier<TContext>,
  ) {}

  /** Build a scope under `parent`, injecting `context` as its identity. */
  build(parent: IInstantiationService, context: TContext): IScopeHandle {
    const collection = new ServiceCollection();

    // ① inject scope identity context
    collection.set(this.contextId, context);

    // ② install Pattern-1 statically registered services as SyncDescriptors
    for (const [id, descriptor] of getScopedServiceDescriptors(this.scope)) {
      collection.set(id, descriptor);
    }

    // ③ reserved build hook (Pattern 2) — NOT enabled in this version.
    this.runBuildHooks(collection, context);

    // ④ reserved post-build interceptor (Pattern 3) — NOT enabled in this version.
    this.runPostBuildInterceptors(collection, context);

    const child = parent.createChild(collection);

    if (!isBuilt()) {
      markBuilt();
    }

    return new ScopeHandle(this.scope, context.id, child);
  }

  /**
   * Reserved Pattern-2 build hook. Intentional no-op in this version — override
   * (or wire a registry) when Pattern 2 is introduced. Runs after Pattern-1
   * descriptors are installed, before `createChild`.
   */
  protected runBuildHooks(_collection: ServiceCollection, _context: TContext): void {
    // no-op: Pattern 2 is not enabled in this version.
  }

  /**
   * Reserved Pattern-3 post-build interceptor. Intentional no-op in this
   * version — runs after the build hook, before `createChild`.
   */
  protected runPostBuildInterceptors(
    _collection: ServiceCollection,
    _context: TContext,
  ): void {
    // no-op: Pattern 3 is not enabled in this version.
  }
}

/** Builds the Session scope (top-most business scope; parent is Core/root). */
export class SessionScopeBuilder extends ScopeBuilder<ISessionContext> {
  constructor() {
    super(LifecycleScope.Session, ISessionContext);
  }
}

/** Builds the Agent scope (child of a Session scope). */
export class AgentScopeBuilder extends ScopeBuilder<IAgentContext> {
  constructor() {
    super(LifecycleScope.Agent, IAgentContext);
  }
}

/** Builds the Turn scope (child of an Agent scope). */
export class TurnScopeBuilder extends ScopeBuilder<ITurnContext> {
  constructor() {
    super(LifecycleScope.Turn, ITurnContext);
  }
}
