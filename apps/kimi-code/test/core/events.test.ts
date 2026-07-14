// Uses fake scope handles shaped like the minimal v2 interface subset;
// does not bootstrap the real engine.
import { describe, expect, it } from 'vitest';
import { attachSessionEvents } from '../../src/core/events';
import type { SessionEvent } from '../../src/core/types';

// -- Minimal fakes: shapes aligned to the smallest subset of the v2 interfaces --
function makeFakeBus() {
  const listeners = new Set<(e: unknown) => void>();
  return {
    subscribe: (h: (e: unknown) => void) => { listeners.add(h); return { dispose: () => listeners.delete(h) }; },
    publish: (e: unknown) => { for (const l of [...listeners]) l(e); },
  };
}
function makeFakeAgent(id: string) { const bus = makeFakeBus(); return { id, bus, accessor: { get: () => bus } }; }
function makeFakeSession(agents: ReturnType<typeof makeFakeAgent>[]) {
  const created = new Set<(h: unknown) => void>();
  const disposed = new Set<(id: string) => void>();
  const lifecycle = {
    list: () => agents,
    onDidCreate: (h: (a: unknown) => void) => { created.add(h); return { dispose: () => created.delete(h) }; },
    onDidDispose: (h: (id: string) => void) => { disposed.add(h); return { dispose: () => disposed.delete(h) }; },
    _create: (a: ReturnType<typeof makeFakeAgent>) => { agents.push(a); for (const h of [...created]) h(a); },
    _dispose: (id: string) => { for (const h of [...disposed]) h(id); },
  };
  return { accessor: { get: () => lifecycle }, lifecycle };
}
function makeFakeApp() {
  const bus = makeFakeBus();
  return { accessor: { get: () => bus }, bus };
}

describe('attachSessionEvents', () => {
  it('stamps agentId/sessionId and keeps v2 event kinds verbatim', () => {
    const a = makeFakeAgent('main');
    const session = makeFakeSession([a]);
    const app = makeFakeApp();
    const seen: SessionEvent[] = [];
    attachSessionEvents({ session: session as never, sessionId: 's1', app: app as never, emit: (e) => seen.push(e) });
    a.bus.publish({ type: 'task.started', info: { taskId: 't1' } });
    expect(seen).toEqual([{ type: 'task.started', info: { taskId: 't1' }, agentId: 'main', sessionId: 's1' }]);
  });

  it('subscribes late-created agents and drops disposed ones', () => {
    const main = makeFakeAgent('main');
    const session = makeFakeSession([main]);
    const app = makeFakeApp();
    const seen: SessionEvent[] = [];
    attachSessionEvents({ session: session as never, sessionId: 's1', app: app as never, emit: (e) => seen.push(e) });

    const sub = makeFakeAgent('sub');
    session.lifecycle._create(sub);
    sub.bus.publish({ type: 'task.started', info: { taskId: 't2' } });
    expect(seen).toEqual([{ type: 'task.started', info: { taskId: 't2' }, agentId: 'sub', sessionId: 's1' }]);

    session.lifecycle._dispose('sub');
    sub.bus.publish({ type: 'task.started', info: { taskId: 't3' } });
    expect(seen).toHaveLength(1);
  });

  it('serializes nested publishes through the flush queue', () => {
    const a = makeFakeAgent('main');
    const session = makeFakeSession([a]);
    const app = makeFakeApp();
    const seen: string[] = [];
    attachSessionEvents({
      session: session as never,
      sessionId: 's1',
      app: app as never,
      emit: (e) => {
        const type = (e as { type: string }).type;
        // Publish the nested event before recording the outer one: without the
        // flush queue the nested emit would re-enter and land first.
        if (type === 'outer') a.bus.publish({ type: 'nested' });
        seen.push(type);
      },
    });
    a.bus.publish({ type: 'outer' });
    expect(seen).toEqual(['outer', 'nested']);
  });

  it('projects session.meta.updated from the app bus filtered by sessionId', () => {
    const a = makeFakeAgent('main');
    const session = makeFakeSession([a]);
    const app = makeFakeApp();
    const seen: SessionEvent[] = [];
    attachSessionEvents({ session: session as never, sessionId: 's1', app: app as never, emit: (e) => seen.push(e) });

    app.bus.publish({ type: 'session.meta.updated', payload: { sessionId: 's1', title: 'T' } });
    // `patch` is undefined here; toEqual treats undefined-valued keys as absent.
    expect(seen).toEqual([{ type: 'session.meta.updated', title: 'T', agentId: 'main', sessionId: 's1' }]);

    app.bus.publish({ type: 'session.meta.updated', payload: { sessionId: 's2', title: 'X' } });
    expect(seen).toHaveLength(1);
  });

  it('teardown unsubscribes every source', () => {
    const a = makeFakeAgent('main');
    const session = makeFakeSession([a]);
    const app = makeFakeApp();
    const seen: SessionEvent[] = [];
    const teardown = attachSessionEvents({ session: session as never, sessionId: 's1', app: app as never, emit: (e) => seen.push(e) });

    a.bus.publish({ type: 'task.started', info: { taskId: 't1' } });
    expect(seen).toHaveLength(1);

    teardown();
    a.bus.publish({ type: 'task.started', info: { taskId: 't2' } });
    app.bus.publish({ type: 'session.meta.updated', payload: { sessionId: 's1', title: 'T' } });
    const late = makeFakeAgent('late');
    session.lifecycle._create(late);
    late.bus.publish({ type: 'task.started', info: { taskId: 't3' } });
    expect(seen).toHaveLength(1);
  });
});
