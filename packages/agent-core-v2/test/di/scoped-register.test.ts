import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator } from '#/_base/di/instantiation';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  getScopedServiceDescriptors,
  registerScopedService,
} from '#/_base/di/scope';

interface ICore {
  tag: 'core';
}
interface ISession {
  tag: 'session';
}
interface IAgent {
  tag: 'agent';
}

const ICore = createDecorator<ICore>('scoped-core');
const ISession = createDecorator<ISession>('scoped-session');
const IAgent = createDecorator<IAgent>('scoped-agent');

class CoreSvc implements ICore {
  tag = 'core' as const;
}
class SessionSvc implements ISession {
  tag = 'session' as const;
}
class AgentSvc implements IAgent {
  tag = 'agent' as const;
}

describe('registerScopedService / getScopedServiceDescriptors', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
  });

  it('filters registrations by scope layer', () => {
    registerScopedService(LifecycleScope.Core, ICore, CoreSvc, InstantiationType.Delayed, 'core-domain');
    registerScopedService(LifecycleScope.Session, ISession, SessionSvc, InstantiationType.Delayed, 'session-domain');
    registerScopedService(LifecycleScope.Agent, IAgent, AgentSvc, InstantiationType.Eager, 'agent-domain');

    expect(getScopedServiceDescriptors(LifecycleScope.Core).map((e) => e.id)).toEqual([ICore]);
    expect(getScopedServiceDescriptors(LifecycleScope.Session).map((e) => e.id)).toEqual([ISession]);
    expect(getScopedServiceDescriptors(LifecycleScope.Agent).map((e) => e.id)).toEqual([IAgent]);
  });

  it('records the domain and delayed-instantiation flag', () => {
    registerScopedService(LifecycleScope.Session, ISession, SessionSvc, InstantiationType.Delayed, 'session-domain');
    registerScopedService(LifecycleScope.Agent, IAgent, AgentSvc, InstantiationType.Eager, 'agent-domain');

    const [sessionEntry] = getScopedServiceDescriptors(LifecycleScope.Session);
    const [agentEntry] = getScopedServiceDescriptors(LifecycleScope.Agent);

    expect(sessionEntry?.domain).toBe('session-domain');
    expect(sessionEntry?.descriptor.supportsDelayedInstantiation).toBe(true);
    expect(agentEntry?.domain).toBe('agent-domain');
    expect(agentEntry?.descriptor.supportsDelayedInstantiation).toBe(false);
  });

  it('allows the same id to coexist at different scopes', () => {
    interface IDual {
      tag: string;
    }
    const IDual = createDecorator<IDual>('scoped-dual');
    class CoreDual implements IDual {
      tag = 'core';
    }
    class SessionDual implements IDual {
      tag = 'session';
    }
    registerScopedService(LifecycleScope.Core, IDual, CoreDual);
    registerScopedService(LifecycleScope.Session, IDual, SessionDual);

    expect(getScopedServiceDescriptors(LifecycleScope.Core)).toHaveLength(1);
    expect(getScopedServiceDescriptors(LifecycleScope.Session)).toHaveLength(1);
    expect(getScopedServiceDescriptors(LifecycleScope.Core)[0]?.id).toBe(IDual);
    expect(getScopedServiceDescriptors(LifecycleScope.Session)[0]?.id).toBe(IDual);
  });
});
