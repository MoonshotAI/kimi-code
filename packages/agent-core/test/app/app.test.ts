import { describe, expect, it, vi } from 'vitest';

import { createApp, createFeature, useAgent, useApp, useSession, useTurnStarting } from '#/app/index';
import { createSystemEntry } from '#/history/message';
import { useCleanup, useFire, useOn, type RuntimeEvent } from '#/kernel/index';
import { extractText } from '#/llm/message';
import { memorySessionSpace } from '#/session/index';
import type { ToolResult } from '#/tool/index';

import {
  agentCaps,
  appEvent,
  echoRequester,
  hangingRequester,
  loopEvent,
  noopExecutor,
  scriptedRequester,
  textOutcome,
  texts,
  user,
} from './fake-llm';

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('app units', () => {
  it('mirrors live sessions and agents as units and forwards their log commits with context', async () => {
    const app = createApp();
    const left = await app.create({ sessionId: 'left' });
    const right = await app.create({ sessionId: 'right' });
    expect([...app.sessions.keys()]).toEqual(['left', 'right']);
    const agent = await left.open('agent-0', agentCaps());
    expect(left.roster.getState().agents['agent-0']).toEqual({});
    expect(right.roster.getState().agents).toEqual({});
    const forwarded = appEvent(app, 'turn.ended');
    expect(agent.loop.submit(user('hello'))?.type).toBe('prompt.submitted');
    expect(await forwarded).toMatchObject({ sessionId: 'left', agentId: 'agent-0', outcome: { type: 'done' } });
    expect(texts(agent)).toContain('echo:hello');
    await app.close();
    expect(app.sessions.size).toBe(0);
    expect(agent.loop.submit(user('late'))).toBeUndefined();
  });

  it('app.wait resolves a matching event and app.on honors once', async () => {
    const app = createApp();
    const created: string[] = [];
    app.on('session.created', (event) => {
      created.push(String(event['sessionId']));
    }, { once: true });
    const waiting = app.wait('session.created', { match: (event) => event['sessionId'] === 'right' });
    await app.create({ sessionId: 'left' });
    await app.create({ sessionId: 'right' });
    expect(created).toEqual(['left']);
    await expect(waiting).resolves.toMatchObject({ sessionId: 'right' });
    await app.close();
  });

  it('app.on and app.wait accept a feature for typed and prefix-matched listening', async () => {
    type ProbeEvent =
      | { readonly type: 'probe.ready'; readonly value: number }
      | { readonly type: 'probe.done'; readonly value: number };
    const probe = createFeature<ProbeEvent>('probe', {
      app: () => {
        const fire = useFire();
        fire({ type: 'stray.tick' });
        fire({ type: 'probe.ready', value: 1 });
        fire({ type: 'probe.done', value: 2 });
      },
    });
    const app = createApp();
    const all: string[] = [];
    app.on(probe, '*', (event) => {
      all.push(event.type);
    });
    const onceSeen: string[] = [];
    app.on(probe, '*', (event) => {
      onceSeen.push(event.type);
    }, { once: true });
    const done: number[] = [];
    app.on(probe, 'probe.done', (event) => {
      done.push(event.value);
    });
    const ready = app.wait(probe, 'probe.ready');
    const remove = app.features.add(probe);
    await expect(ready).resolves.toMatchObject({ type: 'probe.ready', value: 1 });
    await vi.waitFor(() => {
      expect(all).toEqual(['probe.ready', 'probe.done']);
    });
    expect(onceSeen).toEqual(['probe.ready']);
    expect(done).toEqual([2]);
    await remove();
    await app.close();
  });

  it('acknowledges agent inputs synchronously and manages agents within a session', async () => {
    const requests: string[][] = [];
    let pending: ReturnType<typeof gate> | undefined;
    const requester = scriptedRequester((rest) => {
      const messages = rest.content?.messages ?? [];
      requests.push(messages.map((message) => extractText(message)));
      const respond = () => {
        const goIndex = messages.findIndex((message) => message.role === 'user' && extractText(message) === 'go');
        const served = goIndex >= 0 && messages.slice(goIndex).some((message) => message.role === 'tool');
        if (goIndex >= 0 && !served) {
          return textOutcome('', [{ type: 'function', id: `call-${requests.length}`, name: 'ping', arguments: '{}' }]);
        }
        return textOutcome('done');
      };
      const current = pending;
      return current === undefined ? respond() : current.promise.then(respond);
    });
    const executor = {
      execute: async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
    };
    const app = createApp();
    const session = await app.create({ sessionId: 'sess' });
    const agent = await session.open('main', agentCaps(executor, requester));
    expect([...session.agents.keys()]).toEqual(['main']);
    pending = gate();
    expect(agent.loop.notify(user('note', { source: 'notify' }))?.type).toBe('prompt.notified');
    expect(agent.loop.remind(user('reminder-text', { source: 'reminder', key: 'rk' }))?.type).toBe('prompt.reminded');
    const system = createSystemEntry({ role: 'system', content: [{ type: 'text', text: 'sys-reminder' }] }, { source: 'reminder', key: 'sk' });
    expect(agent.loop.remind(system)?.type).toBe('prompt.reminded');
    const first = loopEvent(agent.loop, 'turn.ended');
    expect(agent.loop.submit(user('go'))?.type).toBe('prompt.submitted');
    pending.resolve();
    await first;
    pending = undefined;
    await vi.waitFor(() => {
      expect(requests).toHaveLength(3);
    });
    expect(requests[0]).toEqual(['note']);
    expect(requests[1]).toEqual(['note', 'done', 'go', 'reminder-text', 'sys-reminder']);
    expect(requests[2]).toEqual(expect.arrayContaining(['pong']));
    pending = gate();
    const second = loopEvent(agent.loop, 'turn.ended');
    agent.loop.submit(user('p1', { promptId: 'p1' }));
    agent.loop.submit(user('p2', { promptId: 'p2' }));
    expect(agent.loop.cancel('p2')).toMatchObject({ type: 'prompt.canceled', promptId: 'p2', canceled: true });
    pending.resolve();
    await second;
    pending = undefined;
    expect(requests.flat()).not.toContain('p2');
    expect(agent.loop.steer(['none'])).toMatchObject({ type: 'prompt.steered', promptIds: [] });
    expect(agent.loop.cancel('missing')).toMatchObject({ type: 'prompt.canceled', promptId: 'missing', canceled: false });
    await agent.loop.waitForIdle();
    await agent.flush();
    expect(texts(agent)).toContain('note');
    const copy = await session.fork('main', 'copy', agentCaps(executor, requester));
    expect([...session.agents.keys()]).toEqual(['main', 'copy']);
    expect(texts(copy)).toContain('go');
    await session.close('main');
    expect([...session.agents.keys()]).toEqual(['copy']);
    expect(Object.keys(session.roster.getState().agents)).toEqual(['main', 'copy']);
    await app.close('sess');
    expect(app.sessions.size).toBe(0);
    expect(copy.loop.submit(user('late'))).toBeUndefined();
    await app.close();
  });

  it('waits loop events with match, timeout, and abort signal', async () => {
    const app = createApp();
    const session = await app.create({ sessionId: 'sess' });
    const agent = await session.open('main', agentCaps());
    const done = loopEvent(agent.loop, 'turn.ended', { match: (event) => event.outcome.type === 'done' });
    agent.loop.submit(user('hello'));
    await expect(done).resolves.toMatchObject({ outcome: { type: 'done' } });
    await expect(loopEvent(agent.loop, 'turn.ended', { timeoutMs: 10 })).rejects.toThrow('wait timed out after 10ms');
    const controller = new AbortController();
    const waiting = loopEvent(agent.loop, 'turn.ended', { signal: controller.signal });
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
    await app.close();
  });

  it('runs a full turn only while idle and settles signal aborts and timeouts as aborted outcomes', async () => {
    const caps = agentCaps();
    const app = createApp();
    const session = await app.create({ sessionId: 'sess' });
    const agent = await session.open('main', caps);
    expect((await agent.loop.runTurn(user('hello'))).type).toBe('done');
    expect(agent.loop.state.messages.map((entry) => extractText(entry.message))).toContain('echo:hello');
    const release = gate();
    caps.use(
      scriptedRequester(async (rest) => {
        await release.promise;
        const last = (rest.content?.messages ?? []).at(-1);
        return textOutcome(`echo:${last !== undefined && last.role === 'user' ? extractText(last) : ''}`);
      }),
    );
    const inFlight = agent.loop.runTurn(user('one'));
    await expect(agent.loop.runTurn(user('two'))).rejects.toThrow('runTurn is only accepted while idle');
    release.resolve();
    expect((await inFlight).type).toBe('done');
    caps.use(hangingRequester());
    const controller = new AbortController();
    void loopEvent(agent.loop, 'turn.started').then(() => controller.abort(new Error('stop')));
    await expect(agent.loop.runTurn(user('hang', { promptId: 'h1' }), { signal: controller.signal })).resolves.toMatchObject({
      type: 'aborted',
      reason: expect.any(Error),
    });
    expect(agent.loop.state.inbox.normal.map((entry) => extractText(entry.message))).toEqual(['hang']);
    agent.loop.cancel('h1');
    await expect(
      agent.loop.runTurn(user('hang', { promptId: 'h2' }), { signal: AbortSignal.timeout(10) }),
    ).resolves.toMatchObject({ type: 'aborted' });
    agent.loop.cancel('h2');
    await expect(agent.loop.runTurn(user('skip'), { signal: controller.signal })).resolves.toMatchObject({ type: 'aborted' });
    expect(agent.loop.state.inbox.normal).toEqual([]);
    await app.close();
  });

  it('aborts a detached background tool with abortTool', async () => {
    const requester = scriptedRequester((rest) => {
      const last = (rest.content?.messages ?? []).at(-1);
      if (last !== undefined && last.role === 'user' && extractText(last) === 'bg') {
        return textOutcome('', [{ type: 'function', id: 'call-bg', name: 'bg', arguments: '{}' }]);
      }
      return textOutcome('done');
    });
    const executor = {
      execute: ({ signal, detach }: { signal: AbortSignal; detach?: (text: string) => void }) => {
        detach?.('bg ack');
        return new Promise<ToolResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('bg aborted')));
        });
      },
    };
    const app = createApp();
    const session = await app.create({ sessionId: 'sess' });
    const agent = await session.open('main', agentCaps(executor, requester));
    const detached = loopEvent(agent.loop, 'tool.ended', {
      match: (event) => event.toolCallId === 'call-bg' && event.detached,
    });
    expect(agent.loop.submit(user('bg'))?.type).toBe('prompt.submitted');
    await detached;
    agent.loop.abortTool('missing');
    const settled = loopEvent(agent.loop, 'tool.async_ended', { match: (event) => event.toolCallId === 'call-bg' });
    agent.loop.abortTool('call-bg', 'test stop');
    await expect(settled).resolves.toMatchObject({ outcome: { type: 'aborted', reason: 'test stop' } });
    await app.close();
  });

  it('moves a foreground tool to the background with detachTool and still reports its completion', async () => {
    const requester = scriptedRequester((rest) => {
      const last = (rest.content?.messages ?? []).at(-1);
      if (last !== undefined && last.role === 'user' && extractText(last) === 'fg') {
        return textOutcome('', [{ type: 'function', id: 'call-fg', name: 'fg', arguments: '{}' }]);
      }
      return textOutcome('done');
    });
    let settle: ((result: ToolResult) => void) | undefined;
    const executor = {
      execute: () =>
        new Promise<ToolResult>((resolve) => {
          settle = resolve;
        }),
    };
    const app = createApp();
    const session = await app.create({ sessionId: 'sess' });
    const agent = await session.open('main', agentCaps(executor, requester));
    agent.loop.detachTool('missing');
    const spawned = loopEvent(agent.loop, 'tool.started', { match: (event) => event.toolCall.id === 'call-fg' });
    const detached = loopEvent(agent.loop, 'tool.ended', {
      match: (event) => event.toolCallId === 'call-fg' && event.detached,
    });
    const firstTurn = loopEvent(agent.loop, 'turn.ended', { match: (event) => event.outcome.type === 'done' });
    expect(agent.loop.submit(user('fg'))?.type).toBe('prompt.submitted');
    await spawned;
    agent.loop.detachTool('call-fg');
    await expect(detached).resolves.toMatchObject({
      toolCallId: 'call-fg',
      outcome: {
        entry: {
          message: {
            content: [{ type: 'text', text: 'moved to background by the user: fg (tool_call_id=call-fg)' }],
          },
        },
      },
    });
    await firstTurn;
    await agent.flush();
    const ackEntry = agent.view
      .getState()
      .messages.find((entry) => entry.message.role === 'tool' && entry.message.toolCallId === 'call-fg');
    expect(ackEntry?.message).toMatchObject({
      content: [{ type: 'text', text: 'moved to background by the user: fg (tool_call_id=call-fg)' }],
    });
    const secondTurn = loopEvent(agent.loop, 'turn.ended', { match: (event) => event.outcome.type === 'done' });
    settle?.({ content: [{ type: 'text', text: 'fg output' }] });
    await secondTurn;
    await agent.flush();
    const notification = agent.view.getState().messages.find((entry) => entry.meta?.source === 'async-tool');
    expect(notification?.message).toMatchObject({
      content: [
        { type: 'text', text: '[async tool completed] fg (tool_call_id=call-fg)' },
        { type: 'text', text: 'fg output' },
      ],
    });
    await app.close();
  });

  it('mounts the units of a feature per level, attaches them to their level, and keeps per-instance registration', async () => {
    const app = createApp();
    const session = await app.create({ sessionId: 'sess' });
    const a1 = await session.open('a1', agentCaps());
    const hookIds = (agent: typeof a1) => agent.loop.hooks.list().map((hook) => hook.id);
    const mounted: string[] = [];
    const fires = new Map<string, (event: RuntimeEvent) => void>();
    const heard: Array<[unknown, unknown]> = [];
    const Probe = createFeature<RuntimeEvent, { readonly tag: string }>('probe', {
      session: (props) => {
        expect(() => useAgent()).toThrow("no provider for token 'agent'");
        mounted.push(`+${useSession().id}:${props.tag}`);
        useOn('ping', (event) => {
          heard.push([event['agentId'], event['from']]);
        });
      },
      agent: (props) => {
        const agent = useAgent();
        expect(useSession()).toBe(session);
        expect(useApp()).toBe(app);
        mounted.push(`+${agent.id}:${props.tag}`);
        fires.set(agent.id, useFire());
        useTurnStarting(() => undefined, { id: 'probe' });
        useCleanup(() => {
          mounted.push(`-${agent.id}:${props.tag}`);
        });
      },
    });
    const offApp = app.features.add(Probe, { props: { tag: 'app' } });
    expect([...mounted].sort()).toEqual(['+a1:app', '+sess:app']);
    const a2 = await session.open('a2', agentCaps());
    expect(mounted.slice(2)).toEqual(['+a2:app']);
    expect(hookIds(a2)).toEqual(['probe']);
    fires.get('a1')?.({ type: 'ping', from: 'a1-probe' });
    fires.get('a2')?.({ type: 'ping', from: 'a2-probe' });
    expect(heard).toEqual([
      ['a1', 'a1-probe'],
      ['a2', 'a2-probe'],
    ]);
    const offOwn = app.features.add(Probe, { session: 'sess', agent: 'a2', props: { tag: 'own' } });
    expect(mounted).toHaveLength(3);
    const Other = createFeature('other', {
      app: () => {
        mounted.push('+app:other');
      },
      agent: () => {
        mounted.push(`+${useAgent().id}:other`);
      },
    });
    app.features.add(Other, { session: 'sess' });
    expect(mounted.slice(3).sort()).toEqual(['+a1:other', '+a2:other']);
    expect(app.features.list({ session: 'sess' })).toEqual([Other]);
    expect(() => app.features.add(createFeature('app-only', { app: () => {} }), { session: 'sess' })).toThrow(TypeError);
    expect(() => app.features.add(Probe, { session: 'ghost' })).toThrow("session 'ghost' is not open");
    await offOwn();
    await session.close('a2');
    expect(hookIds(a2)).toEqual([]);
    expect(hookIds(a1)).toEqual(['probe']);
    await offApp();
    expect(hookIds(a1)).toEqual([]);
    expect(mounted.slice(5).sort()).toEqual(['-a1:app', '-a2:app']);
    await app.close();
  });

  it('tracks the open source of sessions across open paths and forwards session.created', async () => {
    const app = createApp({ space: memorySessionSpace() });
    const created: Array<{ sessionId?: unknown; from?: unknown }> = [];
    app.on('session.created', (event) => {
      created.push({ sessionId: event['sessionId'], from: event['from'] });
    });
    const fresh = await app.create({});
    expect(fresh.id).toMatch(/^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(fresh.status().source).toBe('startup');
    expect(created).toEqual([{ sessionId: fresh.id, from: undefined }]);
    const live = await app.create({ sessionId: fresh.id });
    expect(live).toBe(fresh);
    await app.close(fresh.id);
    const resumed = await app.create({ sessionId: fresh.id });
    expect(resumed).not.toBe(fresh);
    expect(resumed.status().source).toBe('resume');
    expect(created).toHaveLength(1);
    const forked = await app.create({ from: fresh.id });
    expect(forked.status().source).toBe('fork');
    expect(created).toEqual([
      { sessionId: fresh.id, from: undefined },
      { sessionId: forked.id, from: fresh.id },
    ]);
    await app.close();
  });

  it('deletes cold and live sessions and forwards session.deleted', async () => {
    const space = memorySessionSpace();
    const app = createApp({ space });
    const cold = await app.create({});
    await app.close(cold.id);
    const live = await app.create({});
    const deleted: unknown[] = [];
    app.on('session.deleted', (event) => {
      deleted.push(event['sessionId']);
    });
    await app.delete(cold.id);
    expect(await space.get(cold.id)).toBeUndefined();
    expect(deleted).toEqual([cold.id]);
    await app.delete(live.id);
    expect(app.sessions.get(live.id)).toBeUndefined();
    await expect(live.open('main', agentCaps())).rejects.toThrow('Writer is closed');
    expect(await space.get(live.id)).toBeUndefined();
    expect(deleted).toEqual([cold.id, live.id]);
    await expect(app.delete(live.id)).rejects.toThrow(`session '${live.id}' does not exist`);
    expect(deleted).toEqual([cold.id, live.id]);
    await app.close();
  });

  it('updates catalog metadata of cold and live sessions once each', async () => {
    const space = memorySessionSpace();
    const app = createApp({ space });
    const cold = await app.create({ title: 'cold' });
    await app.close(cold.id);
    const live = await app.create({ title: 'live' });
    const seen: Array<{ sessionId: unknown; title?: string }> = [];
    app.on('session.meta_updated', (event) => {
      seen.push({ sessionId: event['sessionId'], title: (event['meta'] as { title?: string }).title });
    });
    await app.update(cold.id, { title: 'cold-renamed' });
    expect((await space.get(cold.id))?.title).toBe('cold-renamed');
    await app.update(live.id, { title: 'live-renamed' });
    expect(seen).toEqual([
      { sessionId: cold.id, title: 'cold-renamed' },
      { sessionId: live.id, title: 'live-renamed' },
    ]);
    await app.close();
  });

  it('fires agent.opened with reopened discrimination and agent.closed as agent units mount and unmount', async () => {
    const app = createApp();
    const session = await app.create({ sessionId: 'sess' });
    const opened: Array<{ agentId: unknown; source?: unknown; reopened?: unknown }> = [];
    const closed: unknown[] = [];
    app.on('agent.opened', (event) => {
      opened.push({ agentId: event['agentId'], source: event['source'], reopened: event['reopened'] });
    });
    app.on('agent.closed', (event) => {
      closed.push(event['agentId']);
    });
    await session.open('main', agentCaps(noopExecutor, echoRequester()));
    await session.open('sub-1', agentCaps(), { source: 'spawn:main:coder' });
    await session.fork('main', 'sub-2', agentCaps(), { source: 'btw' });
    const closing = appEvent(app, 'agent.closed');
    await session.close('sub-1');
    await closing;
    await session.open('sub-1', agentCaps());
    expect(opened).toEqual([
      { agentId: 'main', source: undefined, reopened: false },
      { agentId: 'sub-1', source: 'spawn:main:coder', reopened: false },
      { agentId: 'sub-2', source: 'btw', reopened: false },
      { agentId: 'sub-1', source: 'spawn:main:coder', reopened: true },
    ]);
    expect(closed).toEqual(['sub-1']);
    await app.close();
  });
});
