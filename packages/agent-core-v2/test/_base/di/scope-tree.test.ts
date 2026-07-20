import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import {
  LifecycleScope,
  Scope,
  _clearScopedRegistryForTests,
  createAppScope,
  registerScopedService,
} from '#/_base/di/scope';

interface IAppSvc {
  tag: 'app';
}
interface ISessionSvc {
  app: IAppSvc;
  tag: 'session';
}
interface IAgentSvc {
  session: ISessionSvc;
  app: IAppSvc;
  tag: 'agent';
}

const IAppSvc = createDecorator<IAppSvc>('tree-app');
const ISessionSvc = createDecorator<ISessionSvc>('tree-session');
const IAgentSvc = createDecorator<IAgentSvc>('tree-agent');

class AppSvc implements IAppSvc {
  tag = 'app' as const;
}
class SessionSvc implements ISessionSvc {
  tag = 'session' as const;
  constructor(@IAppSvc public readonly app: IAppSvc) {}
}
class AgentSvc implements IAgentSvc {
  tag = 'agent' as const;
  constructor(
    @ISessionSvc public readonly session: ISessionSvc,
    @IAppSvc public readonly app: IAppSvc,
  ) {}
}

describe('Scope tree', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, IAppSvc, AppSvc);
    registerScopedService(LifecycleScope.Session, ISessionSvc, SessionSvc);
    registerScopedService(LifecycleScope.Agent, IAgentSvc, AgentSvc);
  });

  function buildTree(): { app: Scope; session: Scope; agent: Scope } {
    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1');
    const agent = session.createChild(LifecycleScope.Agent, 'main');
    return { app, session, agent };
  }

  it('each scope resolves its own layer service', () => {
    const { app, session, agent } = buildTree();
    expect(app.accessor.get(IAppSvc).tag).toBe('app');
    expect(session.accessor.get(ISessionSvc).tag).toBe('session');
    expect(agent.accessor.get(IAgentSvc).tag).toBe('agent');
    app.dispose();
  });

  it('child resolves ancestor services via createChild fallback', () => {
    const { app, session, agent } = buildTree();
    const sessionSvc = session.accessor.get(ISessionSvc);
    const agentSvc = agent.accessor.get(IAgentSvc);
    expect(sessionSvc.app.tag).toBe('app');
    expect(agentSvc.session.tag).toBe('session');
    expect(agentSvc.app.tag).toBe('app');
    expect(agentSvc.app).toBe(app.accessor.get(IAppSvc));
    app.dispose();
  });

  it('parent cannot resolve a child-layer service', () => {
    const { app, session } = buildTree();
    expect(() => app.accessor.get(ISessionSvc)).toThrow();
    expect(() => session.accessor.get(IAgentSvc)).toThrow();
    app.dispose();
  });

  it('children map tracks created child scopes', () => {
    const { app, session, agent } = buildTree();
    expect(app.children.get('s1')).toBe(session);
    expect(session.children.get('main')).toBe(agent);
    app.dispose();
  });

  it('rejects a child whose kind is not strictly greater', () => {
    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1');
    expect(() => session.createChild(LifecycleScope.Session, 's2')).toThrow(/greater/);
    expect(() => session.createChild(LifecycleScope.App, 'c2')).toThrow(/greater/);
    app.dispose();
  });

  it('rejects duplicate child ids within a parent', () => {
    const app = createAppScope();
    app.createChild(LifecycleScope.Session, 's1');
    expect(() => app.createChild(LifecycleScope.Session, 's1')).toThrow(/already has a child/);
    app.dispose();
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
    registerScopedService(LifecycleScope.App, IA, A, InstantiationType.Eager);
    registerScopedService(LifecycleScope.Session, IB, B, InstantiationType.Eager);
    registerScopedService(LifecycleScope.Agent, IC, C, InstantiationType.Eager);

    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1');
    const agent = session.createChild(LifecycleScope.Agent, 'main');
    app.accessor.get(IA);
    session.accessor.get(IB);
    agent.accessor.get(IC);
    app.dispose();
    expect(events).toEqual(['C', 'B', 'A']);
  });

  it('disposing a child removes it from the parent children map', () => {
    const { app, session, agent } = buildTree();
    agent.dispose();
    expect(session.children.has('main')).toBe(false);
    session.dispose();
    expect(app.children.has('s1')).toBe(false);
    app.dispose();
  });

  it('toHandle exposes id/kind/accessor for parent-domain reach-in', () => {
    const { app, session } = buildTree();
    const handle = session.toHandle();
    expect(handle.id).toBe('s1');
    expect(handle.kind).toBe(LifecycleScope.Session);
    expect(handle.accessor.get(ISessionSvc).tag).toBe('session');
    app.dispose();
  });

  it('extra seed injects a context token resolvable from that scope', () => {
    interface ISessionContext {
      sessionId: string;
    }
    const ISessionContext = createDecorator<ISessionContext>('tree-session-ctx');
    _clearScopedRegistryForTests();

    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1', {
      extra: [[ISessionContext as ServiceIdentifier<unknown>, { sessionId: 's1' }]],
    });
    expect(session.accessor.get(ISessionContext).sessionId).toBe('s1');
    expect(() => app.accessor.get(ISessionContext)).toThrow();
    app.dispose();
  });

  it('use-after-dispose throws on createChild', () => {
    const app = createAppScope();
    const session = app.createChild(LifecycleScope.Session, 's1');
    session.dispose();
    expect(() => session.createChild(LifecycleScope.Agent, 'a1')).toThrow(/disposed/);
    app.dispose();
  });
});
