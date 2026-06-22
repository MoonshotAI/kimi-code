import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstantiationType, _clearRegistryForTests } from '#/di/extensions';
import { IInstantiationService, createDecorator } from '#/di/instantiation';
import { InstantiationService } from '#/di/instantiationService';
import { ServiceCollection } from '#/di/serviceCollection';
import { AgentScopeBuilder, SessionScopeBuilder } from '#/scope/builder';
import { IAgentContext, ISessionContext } from '#/scope/context/index';
import { LifecycleScope } from '#/scope/lifecycle';
import {
  _resetScopeRegistryForTests,
  isBuilt,
  registerScopedService,
} from '#/scope/registry';

interface IPinger {
  ping(): string;
}

class Pinger implements IPinger {
  static constructed = 0;
  constructor() {
    Pinger.constructed += 1;
  }
  ping(): string {
    return 'pong';
  }
}

function sessionContext(id: string): ISessionContext {
  return {
    id,
    abortSignal: new AbortController().signal,
    executionScope: undefined,
  };
}

function agentContext(id: string, parentId: string): IAgentContext {
  return {
    id,
    parentId,
    abortSignal: new AbortController().signal,
    executionScope: undefined,
  };
}

describe('ScopeBuilder + IScopeHandle', () => {
  beforeEach(() => {
    _resetScopeRegistryForTests();
    _clearRegistryForTests();
    Pinger.constructed = 0;
  });

  afterEach(() => {
    _resetScopeRegistryForTests();
    _clearRegistryForTests();
    vi.restoreAllMocks();
  });

  it('builds a Session scope: identity context injected, Pattern-1 services installed, parent.createChild called', () => {
    const IPingerId = createDecorator<IPinger>('p13-session-pinger');
    registerScopedService(
      LifecycleScope.Session,
      IPingerId,
      Pinger,
      InstantiationType.Delayed,
    );

    const parent = new InstantiationService();
    const createChild = vi.spyOn(parent, 'createChild');

    const handle = new SessionScopeBuilder().build(parent, sessionContext('s1'));

    expect(handle.id).toBe('s1');
    expect(handle.scope).toBe(LifecycleScope.Session);
    expect(createChild).toHaveBeenCalledTimes(1);
    expect(createChild.mock.calls[0]![0]).toBeInstanceOf(ServiceCollection);

    // Identity context injected into the child container.
    const ctx = handle.accessor.get(ISessionContext);
    expect(ctx.id).toBe('s1');
    expect(ctx.parentId).toBeUndefined();

    // Pattern-1 service installed and resolvable through the accessor.
    expect(handle.accessor.get(IPingerId).ping()).toBe('pong');
  });

  it('builds an Agent scope as a child of Session (parentId + DI parent chain)', () => {
    const root = new InstantiationService();
    const session = new SessionScopeBuilder().build(root, sessionContext('s1'));

    // The container self-registers under IInstantiationService, so the
    // Session's child container is reachable through its accessor and becomes
    // the Agent builder's parent.
    const sessionContainer = session.accessor.get(IInstantiationService);
    const agent = new AgentScopeBuilder().build(
      sessionContainer,
      agentContext('a1', 's1'),
    );

    expect(agent.id).toBe('a1');
    expect(agent.scope).toBe(LifecycleScope.Agent);

    const aCtx = agent.accessor.get(IAgentContext);
    expect(aCtx.id).toBe('a1');
    expect(aCtx.parentId).toBe('s1');

    // Agent resolves the Session identity through the DI parent chain.
    expect(agent.accessor.get(ISessionContext).id).toBe('s1');
  });

  it('resolves Pattern-1 services lazily (not instantiated at build)', () => {
    const IPingerId = createDecorator<IPinger>('p13-lazy-pinger');
    registerScopedService(
      LifecycleScope.Session,
      IPingerId,
      Pinger,
      InstantiationType.Delayed,
    );

    const handle = new SessionScopeBuilder().build(
      new InstantiationService(),
      sessionContext('s1'),
    );

    // Not instantiated at build time.
    expect(Pinger.constructed).toBe(0);

    // get() returns a lazy proxy; the ctor still has not run.
    const proxy = handle.accessor.get(IPingerId);
    expect(Pinger.constructed).toBe(0);

    // First real use triggers construction.
    expect(proxy.ping()).toBe('pong');
    expect(Pinger.constructed).toBe(1);

    // The proxy is cached on subsequent access.
    expect(handle.accessor.get(IPingerId)).toBe(proxy);
  });

  it('dispose fires onWillDispose → disposes child services → onDidDispose in order', async () => {
    const order: string[] = [];
    interface ITracked {
      readonly marker: string;
      touch(): void;
    }
    class Tracked implements ITracked {
      readonly marker = 'tracked';
      touch(): void {
        // no-op; realizing the lazy proxy forces construction.
      }
      dispose(): void {
        order.push('service.dispose');
      }
    }
    const ITrackedId = createDecorator<ITracked>('p13-order-tracked');
    registerScopedService(
      LifecycleScope.Session,
      ITrackedId,
      Tracked,
      InstantiationType.Delayed,
    );

    const handle = new SessionScopeBuilder().build(
      new InstantiationService(),
      sessionContext('s1'),
    );
    // Realize the lazy proxy so the instance is constructed and tracked for
    // disposal during teardown.
    handle.accessor.get(ITrackedId).touch();

    handle.onWillDispose(() => order.push('onWillDispose'));
    handle.onDidDispose(() => order.push('onDidDispose'));

    await handle.dispose();

    expect(order).toEqual(['onWillDispose', 'service.dispose', 'onDidDispose']);
  });

  it('onWillDispose listeners can read child services; onDidDispose listeners cannot', async () => {
    const IPingerId = createDecorator<IPinger>('p13-dispose-pinger');
    registerScopedService(
      LifecycleScope.Session,
      IPingerId,
      Pinger,
      InstantiationType.Delayed,
    );

    const handle = new SessionScopeBuilder().build(
      new InstantiationService(),
      sessionContext('s1'),
    );

    let willRead: string | undefined;
    let didThrew = false;

    handle.onWillDispose(() => {
      // Data still present — resolves successfully.
      willRead = handle.accessor.get(IPingerId).ping();
    });
    handle.onDidDispose(() => {
      // Data gone — container disposed, resolving throws.
      try {
        handle.accessor.get(IPingerId);
      } catch {
        didThrew = true;
      }
    });

    await handle.dispose();

    expect(willRead).toBe('pong');
    expect(didThrew).toBe(true);
  });

  it('awaits async onWillDispose listeners before disposing child services', async () => {
    const order: string[] = [];
    const handle = new SessionScopeBuilder().build(
      new InstantiationService(),
      sessionContext('s1'),
    );

    handle.onWillDispose(async () => {
      await Promise.resolve();
      order.push('onWillDispose.async');
    });
    handle.onDidDispose(() => order.push('onDidDispose'));

    await handle.dispose();

    expect(order).toEqual(['onWillDispose.async', 'onDidDispose']);
  });

  it('calls markBuilt() on the first build; later registrations warn and are ignored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(isBuilt()).toBe(false);
    new SessionScopeBuilder().build(new InstantiationService(), sessionContext('s1'));
    expect(isBuilt()).toBe(true);

    const ILateId = createDecorator<IPinger>('p13-late-pinger');
    registerScopedService(
      LifecycleScope.Session,
      ILateId,
      Pinger,
      InstantiationType.Delayed,
    );

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toMatch(/after the first/);
  });
});
