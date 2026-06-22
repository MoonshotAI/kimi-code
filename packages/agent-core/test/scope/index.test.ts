import { describe, expect, it } from 'vitest';

import * as scope from '#/scope/index';
import type {
  IChildLifecycleEvent,
  IManagerEventBus,
  IManagerService,
  IScopeHandle,
  IServiceAccessor,
} from '#/scope/index';
import * as root from '#/index';

// Compile-time helper: referencing a type parameter inside a call expression
// proves the type is exported and resolves, without emitting runtime logic or
// triggering unused-binding warnings.
function assertType<T>(): void {
  // intentionally empty — the type parameter is the assertion.
}

describe('scope barrel (#/scope)', () => {
  it('exports the scope surface as values', () => {
    // lifecycle enum (Core → Session → Agent → Turn → ToolCall)
    expect(scope.LifecycleScope).toBeDefined();
    expect(scope.LifecycleScope.Core).toBe('core');
    expect(scope.LifecycleScope.Session).toBe('session');
    expect(scope.LifecycleScope.Agent).toBe('agent');
    expect(scope.LifecycleScope.Turn).toBe('turn');
    expect(scope.LifecycleScope.ToolCall).toBe('toolCall');

    // Pattern-1 registry entry points
    expect(typeof scope.registerScopedService).toBe('function');
    expect(typeof scope.getScopedServiceDescriptors).toBe('function');
    expect(typeof scope.markBuilt).toBe('function');
    expect(typeof scope.isBuilt).toBe('function');

    // builders
    expect(typeof scope.ScopeBuilder).toBe('function');
    expect(typeof scope.SessionScopeBuilder).toBe('function');
    expect(typeof scope.AgentScopeBuilder).toBe('function');
    expect(typeof scope.TurnScopeBuilder).toBe('function');

    // manager base
    expect(typeof scope.ScopeManager).toBe('function');

    // identity contexts (declaration-merged interface + decorator value)
    expect(typeof scope.ISessionContext).toBe('function');
    expect(typeof scope.IAgentContext).toBe('function');
    expect(typeof scope.ITurnContext).toBe('function');
    expect(typeof scope.IToolCallContext).toBe('function');
  });

  it('exports the scope contract types', () => {
    assertType<IScopeHandle>();
    assertType<IServiceAccessor>();
    assertType<IManagerService<IScopeHandle>>();
    assertType<IManagerEventBus<IChildLifecycleEvent>>();
    assertType<IChildLifecycleEvent>();
  });

  it('constructs concrete builders from the barrel', () => {
    expect(new scope.SessionScopeBuilder()).toBeInstanceOf(scope.ScopeBuilder);
    expect(new scope.AgentScopeBuilder()).toBeInstanceOf(scope.ScopeBuilder);
    expect(new scope.TurnScopeBuilder()).toBeInstanceOf(scope.ScopeBuilder);
  });
});

describe('top-level barrel (#/index)', () => {
  it('re-exports the scope surface from @moonshot-ai/agent-core', () => {
    // representative symbols from each scope module must be the SAME bindings
    // reachable through the top-level barrel.
    expect(root.LifecycleScope).toBe(scope.LifecycleScope);
    expect(root.registerScopedService).toBe(scope.registerScopedService);
    expect(root.getScopedServiceDescriptors).toBe(scope.getScopedServiceDescriptors);
    expect(root.markBuilt).toBe(scope.markBuilt);
    expect(root.isBuilt).toBe(scope.isBuilt);
    expect(root.ScopeBuilder).toBe(scope.ScopeBuilder);
    expect(root.SessionScopeBuilder).toBe(scope.SessionScopeBuilder);
    expect(root.AgentScopeBuilder).toBe(scope.AgentScopeBuilder);
    expect(root.TurnScopeBuilder).toBe(scope.TurnScopeBuilder);
    expect(root.ScopeManager).toBe(scope.ScopeManager);
    expect(root.ISessionContext).toBe(scope.ISessionContext);
    expect(root.IAgentContext).toBe(scope.IAgentContext);
    expect(root.ITurnContext).toBe(scope.ITurnContext);
    expect(root.IToolCallContext).toBe(scope.IToolCallContext);
  });
});
