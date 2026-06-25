import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import {
  LifecycleScope,
  Scope,
  _clearScopedRegistryForTests,
  createCoreScope,
  registerScopedService,
} from '#/_base/di/scope';

interface ICoreSvc {
  tag: 'core';
}
interface ISessionSvc {
  core: ICoreSvc;
  tag: 'session';
}
interface IAgentSvc {
  session: ISessionSvc;
  core: ICoreSvc;
  tag: 'agent';
}

const ICoreSvc = createDecorator<ICoreSvc>('tree-core');
const ISessionSvc = createDecorator<ISessionSvc>('tree-session');
const IAgentSvc = createDecorator<IAgentSvc>('tree-agent');

class CoreSvc implements ICoreSvc {
  tag = 'core' as const;
}
class SessionSvc implements ISessionSvc {
  tag = 'session' as const;
  constructor(@ICoreSvc public readonly core: ICoreSvc) {}
}
class AgentSvc implements IAgentSvc {
  tag = 'agent' as const;
  constructor(
    @ISessionSvc public readonly session: ISessionSvc,
    @ICoreSvc public readonly core: ICoreSvc,
  ) {}
}

describe('Scope tree', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.Core, ICoreSvc, CoreSvc);
    registerScopedService(LifecycleScope.Session, ISessionSvc, SessionSvc);
    registerScopedService(LifecycleScope.Agent, IAgentSvc, AgentSvc);
  });

  function buildTree(): { core: Scope; session: Scope; agent: Scope } {
    const core = createCoreScope();
    const session = core.createChild(LifecycleScope.Session, 's1');
    const agent = session.createChild(LifecycleScope.Agent, 'main');
    return { core, session, agent };
  }

  it('each scope resolves its own layer service', () => {
    const { core, session, agent } = buildTree();
    expect(core.accessor.get(ICoreSvc).tag).toBe('core');
    expect(session.accessor.get(ISessionSvc).tag).toBe('session');
    expect(agent.accessor.get(IAgentSvc).tag).toBe('agent');
    core.dispose();
  });

  it('child resolves ancestor services via createChild fallback', () => {
    const { core, session, agent } = buildTree();
    const sessionSvc = session.accessor.get(ISessionSvc);
    const agentSvc = agent.accessor.get(IAgentSvc);
    expect(sessionSvc.core.tag).toBe('core');
    expect(agentSvc.session.tag).toBe('session');
    expect(agentSvc.core.tag).toBe('core');
    expect(agentSvc.core).toBe(core.accessor.get(ICoreSvc));
    core.dispose();
  });

  it('parent cannot resolve a child-layer service', () => {
    const { core, session } = buildTree();
    expect(() => core.accessor.get(ISessionSvc)).toThrow();
    expect(() => session.accessor.get(IAgentSvc)).toThrow();
    core.dispose();
  });

  it('children map tracks created child scopes', () => {
    const { core, session, agent } = buildTree();
    expect(core.children.get('s1')).toBe(session);
    expect(session.children.get('main')).toBe(agent);
    core.dispose();
  });

  it('rejects a child whose kind is not strictly greater', () => {
    const core = createCoreScope();
    const session = core.createChild(LifecycleScope.Session, 's1');
    expect(() => session.createChild(LifecycleScope.Session, 's2')).toThrow(/greater/);
    expect(() => session.createChild(LifecycleScope.Core, 'c2')).toThrow(/greater/);
    core.dispose();
  });

  it('rejects duplicate child ids within a parent', () => {
    const core = createCoreScope();
    core.createChild(LifecycleScope.Session, 's1');
    expect(() => core.createChild(LifecycleScope.Session, 's1')).toThrow(/already has a child/);
    core.dispose();
  });

  it('dispose tears down children before the parent (C→B→A)', () => {
    const events: string[] = [];
    interface ITagged extends IDisposable {
      tag: string;
    }
    const IA = createDecorator<ITagged>('tree-dispose-A');
    const IB = createDecorator<ITagged>('tree-dispose-B');
    const IC = createDecorator<ITagged>('tree-dispose-C');
    _clearScopedRegistryForTests();
    class A implements ITagged {
      tag = 'A';
      dispose(): void { events.push('A'); }
    }
    class B implements ITagged {
      tag = 'B';
      dispose(): void { events.push('B'); }
    }
    class C implements ITagged {
      tag = 'C';
      dispose(): void { events.push('C'); }
    }
    registerScopedService(LifecycleScope.Core, IA, A, InstantiationType.Eager);
    registerScopedService(LifecycleScope.Session, IB, B, InstantiationType.Eager);
    registerScopedService(LifecycleScope.Agent, IC, C, InstantiationType.Eager);

    const core = createCoreScope();
    const session = core.createChild(LifecycleScope.Session, 's1');
    const agent = session.createChild(LifecycleScope.Agent, 'main');
    core.accessor.get(IA);
    session.accessor.get(IB);
    agent.accessor.get(IC);
    core.dispose();
    expect(events).toEqual(['C', 'B', 'A']);
  });

  it('disposing a child removes it from the parent children map', () => {
    const { core, session, agent } = buildTree();
    agent.dispose();
    expect(session.children.has('main')).toBe(false);
    session.dispose();
    expect(core.children.has('s1')).toBe(false);
    core.dispose();
  });

  it('toHandle exposes id/kind/accessor for parent-domain reach-in', () => {
    const { core, session } = buildTree();
    const handle = session.toHandle();
    expect(handle.id).toBe('s1');
    expect(handle.kind).toBe(LifecycleScope.Session);
    expect(handle.accessor.get(ISessionSvc).tag).toBe('session');
    core.dispose();
  });

  it('extra seed injects a context token resolvable from that scope', () => {
    interface ISessionContext {
      sessionId: string;
    }
    const ISessionContext = createDecorator<ISessionContext>('tree-session-ctx');
    _clearScopedRegistryForTests();

    const core = createCoreScope();
    const session = core.createChild(LifecycleScope.Session, 's1', {
      extra: [[ISessionContext as ServiceIdentifier<unknown>, { sessionId: 's1' }]],
    });
    expect(session.accessor.get(ISessionContext).sessionId).toBe('s1');
    expect(() => core.accessor.get(ISessionContext)).toThrow();
    core.dispose();
  });

  it('use-after-dispose throws on createChild', () => {
    const core = createCoreScope();
    const session = core.createChild(LifecycleScope.Session, 's1');
    session.dispose();
    expect(() => session.createChild(LifecycleScope.Agent, 'a1')).toThrow(/disposed/);
    core.dispose();
  });
});
