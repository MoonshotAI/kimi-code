import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator } from '#/_base/di/instantiation';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  getScopedServiceDescriptors,
  registerScopedService,
} from '#/_base/di/scope';

interface IApp {
  tag: 'app';
}
interface ISession {
  tag: 'session';
}
interface IAgent {
  tag: 'agent';
}

const IApp = createDecorator<IApp>('scoped-app');
const ISession = createDecorator<ISession>('scoped-session');
const IAgent = createDecorator<IAgent>('scoped-agent');

class AppSvc implements IApp {
  tag = 'app' as const;
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
    registerScopedService(LifecycleScope.App, IApp, AppSvc, InstantiationType.Delayed, 'app-domain');
    registerScopedService(LifecycleScope.Session, ISession, SessionSvc, InstantiationType.Delayed, 'session-domain');
    registerScopedService(LifecycleScope.Agent, IAgent, AgentSvc, InstantiationType.Eager, 'agent-domain');

    expect(getScopedServiceDescriptors(LifecycleScope.App).map((e) => e.id)).toEqual([IApp]);
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
    class AppDual implements IDual {
      tag = 'app';
    }
    class SessionDual implements IDual {
      tag = 'session';
    }
    registerScopedService(LifecycleScope.App, IDual, AppDual);
    registerScopedService(LifecycleScope.Session, IDual, SessionDual);

    expect(getScopedServiceDescriptors(LifecycleScope.App)).toHaveLength(1);
    expect(getScopedServiceDescriptors(LifecycleScope.Session)).toHaveLength(1);
    expect(getScopedServiceDescriptors(LifecycleScope.App)[0]?.id).toBe(IDual);
    expect(getScopedServiceDescriptors(LifecycleScope.Session)[0]?.id).toBe(IDual);
  });

  it('register without domain still records the service', () => {
    registerScopedService(LifecycleScope.App, IApp, AppSvc);
    const entries = getScopedServiceDescriptors(LifecycleScope.App);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(IApp);
  });

  it('register with Eager vs Delayed both work', () => {
    registerScopedService(LifecycleScope.App, IApp, AppSvc, InstantiationType.Eager);
    registerScopedService(LifecycleScope.Session, ISession, SessionSvc, InstantiationType.Delayed);
    const appEntries = getScopedServiceDescriptors(LifecycleScope.App);
    const sessionEntries = getScopedServiceDescriptors(LifecycleScope.Session);
    expect(appEntries[0]?.descriptor.supportsDelayedInstantiation).toBe(false);
    expect(sessionEntries[0]?.descriptor.supportsDelayedInstantiation).toBe(true);
  });

  it('getScopedServiceDescriptors for a scope with no registrations returns empty', () => {
    expect(getScopedServiceDescriptors(LifecycleScope.Agent)).toEqual([]);
  });
});
