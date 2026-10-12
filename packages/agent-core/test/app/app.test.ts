import { describe, expect, it, vi } from 'vitest';

import { createUserMessage, extractText, type SystemMessage } from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { openBlobs, type Blobs } from '#/store/blob';
import { MemoryBackend, Trees } from '#/store/tree';
import { openSessionStores, type RosterEntry, type SessionStores } from '#/stores/session';
import { createFacadeToken, useExpose, useFire, useInject, ref, type Ref, type RuntimeEvent } from '#/kernel/index';
import { createFeature, useAgentTools, useBlobs, useOnAgent, useOnApp, useOnSession, useSession, useSessionStore } from '#/feature/index';
import { createHarness, memorySessionSpace, type AgentHandle } from '#/app/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function createEchoRequester(): LlmRequester {
  return {
    generate: (_config, { messages }, { onEvent }) => {
      const last = messages.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: `echo:${text}` } });
      onEvent?.({ type: 'llm.done' });
      return Promise.resolve();
    },
  };
}

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

function turnDone(agent: AgentHandle): Promise<string[]> {
  return new Promise((resolve) => {
    agent.on('turn.done', (event) => {
      resolve(event.messages.map((entry) => extractText(entry.message)));
    });
  });
}

const AppCounter = createFacadeToken<{ count: Ref<number> }>('test.appCounter');
const SessionCounter = createFacadeToken<{
  count: Ref<number>;
  appCount: Ref<number>;
  roster(): Record<string, RosterEntry>;
  blobs: Blobs;
}>('test.sessionCounter');

describe('app-session-agent units', () => {
  it('assembles the three-tier unit tree and runs a real turn with isolated session features', async () => {
    const envA = await testStores();
    const envB = await testStores();
    const seen: string[] = [];
    const appSpec = createFeature('app-probe', {
      app() {
        useExpose(AppCounter, { count: ref(0) });
      },
    });
    interface ProbeReady extends RuntimeEvent {
      readonly type: 'session-probe.ready';
      readonly sessionId: string;
    }
    const sessionSpec = createFeature<ProbeReady>('session-probe', {
      session() {
        const appState = useInject(AppCounter).value!;
        const sessionStore = useSessionStore();
        useExpose(SessionCounter, {
          count: ref(0),
          appCount: appState.count,
          roster: () => sessionStore.getState().roster.agents,
          blobs: useBlobs(),
        });
        useFire()({ type: 'session-probe.ready', sessionId: useSession().sessionId });
      },
    });
    const app = createHarness({ features: [appSpec, sessionSpec] });
    await app.ready();
    app.on(sessionSpec, 'session-probe.ready', (event) => {
      seen.push(event.sessionId);
    });
    app.resolve(AppCounter)!.count.value += 1;
    expect(app.resolve(AppCounter)!.count.value).toBe(1);
    const leftReady = app.wait(sessionSpec, 'session-probe.ready');
    const left = await app.create({ sessionId: 'left', stores: envA.stores });
    expect((await leftReady).sessionId).toBe('left');
    const rightReady = app.wait(sessionSpec, 'session-probe.ready');
    const right = await app.create({ sessionId: 'right', stores: envB.stores });
    expect((await rightReady).sessionId).toBe('right');
    expect(app.list()).toEqual(['left', 'right']);
    expect(app.get('left')).toBe(left);
    expect(seen).toEqual(['left', 'right']);
    expect(left.resolve(SessionCounter)!.blobs).toBe(envA.stores.blobs);
    expect(right.resolve(SessionCounter)!.blobs).toBe(envB.stores.blobs);
    left.resolve(SessionCounter)!.count.value += 1;
    expect(left.resolve(SessionCounter)!.count.value).toBe(1);
    expect(right.resolve(SessionCounter)!.count.value).toBe(0);
    expect(left.resolve(SessionCounter)!.appCount.value).toBe(1);
    expect(right.resolve(SessionCounter)!.appCount.value).toBe(1);
    const agent = await left.create({ agentId: 'agent-0' });
    agent.setConfig({ model });
    agent.setRequester(createEchoRequester());
    expect(left.resolve(SessionCounter)!.roster()).toEqual({
      'agent-0': { branch: 'agent-0', features: ['app-probe', 'session-probe'] },
    });
    expect(right.resolve(SessionCounter)!.roster()).toEqual({});
    const done = turnDone(agent);
    expect(agent.submit(createUserMessage('hello'))?.type).toBe('prompt.submitted');
    expect(await done).toContain('echo:hello');
    const store = envA.stores.get('agent-0');
    await envA.stores.flush();
    expect(store?.getState().history.some((entry) => extractText(entry.message) === 'echo:hello')).toBe(true);
    const ExtraCounter = createFacadeToken<{ count: Ref<number> }>('test.extraCounter');
    const extraSpec = createFeature('extra', {
      app() {
        useExpose(ExtraCounter, { count: ref(0) });
      },
    });
    app.installFeature(extraSpec);
    await app.ready();
    app.resolve(ExtraCounter)!.count.value = 7;
    expect(app.resolve(ExtraCounter)!.count.value).toBe(7);
    expect(() => app.installFeature(extraSpec)).toThrow('already installed');
    expect(app.uninstallFeature(extraSpec)).toBe(true);
    await app.ready();
    expect(app.resolve(ExtraCounter)).toBeUndefined();
    app.installFeature(extraSpec);
    await app.ready();
    expect(app.resolve(ExtraCounter)!.count.value).toBe(0);
    expect(app.uninstallFeature('extra')).toBe(true);
    expect(app.uninstallFeature('extra')).toBe(false);
    await app.close();
    expect(agent.state).toBe('unmounted');
    expect(left.state).toBe('unmounted');
    expect(app.list()).toEqual([]);
    await expect(agent.ready()).rejects.toThrow('unmounted');
    expect(app.resolve(AppCounter)).toBeUndefined();
    await envA.stores.dispose();
    await envB.stores.dispose();
  });

  it('exposes session agent management and agent input interfaces', async () => {
    const requests: string[][] = [];
    let gate: PromiseWithResolvers<void> | undefined;
    const requester: LlmRequester = {
      generate: (_config, { messages }, { onEvent }) => {
        requests.push(messages.map((message) => extractText(message)));
        const respond = (): void => {
          const last = messages.at(-1);
          const lastUser = messages.toReversed().find((message) => message.role === 'user');
          if (last !== undefined && last.role === 'tool') {
            onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'done' } });
          } else if (lastUser !== undefined && extractText(lastUser) === 'go') {
            onEvent?.({ type: 'llm.streaming.part', part: { type: 'function', id: `call-${requests.length}`, name: 'ping', arguments: '{}' } });
          } else {
            onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'done' } });
          }
          onEvent?.({ type: 'llm.done' });
        };
        const pending = gate;
        if (pending === undefined) {
          respond();
          return Promise.resolve();
        }
        return pending.promise.then(respond);
      },
    };
    const spec = createFeature('probe', {
      agent() {
        useAgentTools({
          name: 'ping',
          description: 'ping',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
        });
      },
    });
    const env = await testStores();
    const app = createHarness({ features: [spec] });
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main' });
    agent.setConfig({ model });
    agent.setRequester(requester);
    expect(session.list()).toEqual(['main']);
    expect(session.get('main')).toBe(agent);
    gate = Promise.withResolvers<void>();
    expect(agent.notify(createUserMessage('note'))?.type).toBe('prompt.notified');
    expect(agent.remind(createUserMessage('reminder-text'), { key: 'rk' })?.type).toBe('prompt.reminded');
    expect(agent.remind({ role: 'system', content: [{ type: 'text', text: 'sys-reminder' }] } satisfies SystemMessage, { key: 'sk' })?.type).toBe('prompt.reminded');
    const first = turnDone(agent);
    expect(agent.submit(createUserMessage('go'))?.type).toBe('prompt.submitted');
    gate.resolve();
    await first;
    gate = undefined;
    await vi.waitFor(() => { expect(requests).toHaveLength(3); });
    expect(requests[0]).toEqual(['note']);
    expect(requests[1]).toEqual(['note', 'done', 'go']);
    expect(requests[2]).toEqual(expect.arrayContaining(['pong', 'reminder-text', 'sys-reminder']));
    gate = Promise.withResolvers<void>();
    const second = turnDone(agent);
    agent.submit(createUserMessage('p1'), { promptId: 'p1' });
    agent.submit(createUserMessage('p2'), { promptId: 'p2' });
    expect(agent.cancel('p2')).toMatchObject({ type: 'prompt.cancelled', id: 'p2', cancelled: true });
    gate.resolve();
    await second;
    expect(requests).toHaveLength(4);
    expect(requests.flat()).not.toContain('p2');
    expect(agent.pause()?.type).toBe('agent.paused');
    expect(agent.continue()?.type).toBe('agent.continued');
    expect(agent.abort()?.type).toBe('agent.aborted');
    expect(agent.steer(['none'])).toMatchObject({ type: 'prompt.steered', ids: ['none'], queueItemIds: [] });
    expect(agent.cancel('missing')).toMatchObject({ type: 'prompt.cancelled', id: 'missing', cancelled: false });
    const store = env.stores.get('main');
    await env.stores.flush();
    expect(store?.getState().history.some((entry) => extractText(entry.message) === 'note')).toBe(true);
    const copy = await session.fork('main', { agentId: 'copy' });
    copy.setConfig({ model });
    copy.setRequester(requester);
    expect(session.list()).toEqual(['main', 'copy']);
    const copyStore = env.stores.get('copy');
    expect(copyStore?.getState().history.some((entry) => extractText(entry.message) === 'go')).toBe(true);
    await session.close('main');
    expect(session.list()).toEqual(['copy']);
    const sessionLog = env.stores.session;
    expect(Object.keys(sessionLog.getState().roster.agents)).toEqual(['main', 'copy']);
    await app.close('sess');
    expect(app.list()).toEqual([]);
    expect(session.state).toBe('unmounted');
    expect(copy.state).toBe('unmounted');
    await env.stores.dispose();
  });

  it('waits machine events with match, timeout, and abort signal', async () => {
    const env = await testStores();
    const app = createHarness({});
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main' });
    agent.setConfig({ model });
    agent.setRequester(createEchoRequester());
    const done = agent.wait('turn.done', { match: (event) => event.outcome.type === 'done' });
    agent.submit(createUserMessage('hello'));
    await expect(done).resolves.toMatchObject({ outcome: { type: 'done' } });
    await expect(agent.wait('turn.done', { timeoutMs: 10 })).rejects.toThrow("wait 'turn.done' timed out after 10ms");
    const controller = new AbortController();
    const pending = agent.wait('turn.done', { signal: controller.signal });
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('runs a full turn with agent.run, requires an idle agent, and rejects on external abort or timeout', async () => {
    const env = await testStores();
    const app = createHarness({});
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main' });
    agent.setConfig({ model });
    agent.setRequester(createEchoRequester());
    const first = await agent.run(createUserMessage('hello'));
    expect(first.outcome.type).toBe('done');
    expect(first.turnId).toBeGreaterThanOrEqual(0);
    expect(first.branchId).toBe('main');
    expect(first.messages.map((entry) => extractText(entry.message))).toContain('echo:hello');
    const inFlight = agent.run(createUserMessage('one'));
    await expect(agent.run(createUserMessage('two'))).rejects.toThrow('agent is busy');
    await expect(agent.retry()).rejects.toThrow('agent is busy');
    expect((await inFlight).outcome.type).toBe('done');
    const hanging: LlmRequester = {
      generate: (_config, _content, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve());
        }),
    };
    agent.setRequester(hanging);
    const controller = new AbortController();
    const aborted = agent.run(createUserMessage('hang'), {
      signal: controller.signal,
      onStarted: () => controller.abort(new Error('stop')),
    });
    const woundDown = agent.wait('turn.done', { timeoutMs: 15000 }).catch(() => {});
    await expect(aborted).rejects.toThrow('stop');
    await woundDown;
    const timedOut = agent.run(createUserMessage('hang'), { timeoutMs: 10 });
    const timedOutWoundDown = agent.wait('turn.done', { timeoutMs: 15000 }).catch(() => {});
    await expect(timedOut).rejects.toThrow('run timed out after 10ms');
    await timedOutWoundDown;
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('retries with agent.retry and settles external aborts as outcomes with abortAsOutcome', async () => {
    const env = await testStores();
    const app = createHarness({});
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main' });
    agent.setConfig({ model });
    agent.setRequester(createEchoRequester());
    const retried = await agent.retry();
    expect(retried.outcome.type).toBe('done');
    const history = env.stores.get('main')?.getState().history ?? [];
    const retryEntry = history.find(
      (entry) => entry.message.role === 'user' && entry.meta?.origin?.kind === 'retry',
    );
    expect(retryEntry?.message).toMatchObject({ role: 'user', content: [] });
    const hanging: LlmRequester = {
      generate: (_config, _content, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve());
        }),
    };
    agent.setRequester(hanging);
    const controller = new AbortController();
    const settled = agent.run(createUserMessage('hang'), {
      signal: controller.signal,
      onStarted: () => controller.abort(new Error('stop')),
      abortAsOutcome: true,
    });
    const woundDown = agent.wait('turn.done', { timeoutMs: 15000 }).catch(() => {});
    await expect(settled).resolves.toMatchObject({
      outcome: { type: 'aborted', reason: expect.any(Error) },
    });
    await woundDown;
    await expect(
      agent.retry({ signal: controller.signal, abortAsOutcome: true }),
    ).resolves.toMatchObject({ outcome: { type: 'aborted', reason: expect.any(Error) } });
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('aborts a detached background tool with abortTool', async () => {
    const requester: LlmRequester = {
      generate: (_config, { messages }, { onEvent }) => {
        const last = messages.at(-1);
        if (last !== undefined && last.role === 'user' && extractText(last) === 'bg') {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'function', id: 'call-bg', name: 'bg', arguments: '{}' } });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'done' } });
        }
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };
    const spec = createFeature('probe', {
      agent() {
        useAgentTools({
          name: 'bg',
          description: 'detach and hang',
          parameters: { type: 'object', properties: {} },
          execute: ({ signal, detach }) => {
            detach?.('bg ack');
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('bg aborted')));
            });
          },
        });
      },
    });
    const env = await testStores();
    const app = createHarness({ features: [spec] });
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main' });
    agent.setConfig({ model });
    agent.setRequester(requester);
    const detached = agent.wait('tool.detached', { match: (event) => event.toolCallId === 'call-bg' });
    expect(agent.submit(createUserMessage('bg'))?.type).toBe('prompt.submitted');
    await detached;
    expect(agent.abortTool('missing')).toBeUndefined();
    const settled = agent.wait('tool.done', { match: (event) => event.toolCallId === 'call-bg' });
    agent.abortTool('call-bg', 'test stop');
    await expect(settled).resolves.toMatchObject({ outcome: { type: 'aborted', reason: 'test stop' } });
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('counts steps monotonically across drains and fails with max_steps even when a drain carries messages', async () => {
    let requests = 0;
    const requester: LlmRequester = {
      generate: (_config, _input, { onEvent }) => {
        requests += 1;
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'function', id: `call-${requests}`, name: 'spin', arguments: '{}' } });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };
    const spec = createFeature('probe', {
      agent() {
        useAgentTools({
          name: 'spin',
          description: 'keep the turn going',
          parameters: { type: 'object', properties: {} },
          execute: () => Promise.resolve({ content: [{ type: 'text', text: 'spun' }] }),
        });
      },
    });
    const env = await testStores();
    const app = createHarness({ features: [spec] });
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main', machineOptions: { maxStepsPerTurn: 2 } });
    agent.setConfig({ model });
    agent.setRequester(requester);
    const done = new Promise<{ outcome: unknown; texts: string[] }>((resolve) => {
      agent.on('turn.done', (event) => {
        resolve({ outcome: event.outcome, texts: event.messages.map((entry) => extractText(entry.message)) });
      });
    });
    expect(agent.submit(createUserMessage('go'))?.type).toBe('prompt.submitted');
    agent.remind(createUserMessage('mid-turn note'));
    const result = await done;
    expect(requests).toBe(2);
    expect(result.outcome).toMatchObject({ type: 'failed', failure: { reason: 'max_steps' } });
    expect(result.texts).toContain('mid-turn note');
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('generates v2-style session ids when opening without an explicit id', async () => {
    const app = createHarness({ space: memorySessionSpace() });
    const session = await app.open({});
    expect(session.sessionId).toMatch(
      /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    await app.disposeAsync();
  });

  it('tracks the open source of sessions across open paths', async () => {
    const space = memorySessionSpace();
    const app = createHarness({ space });
    const created: Array<{ sessionId?: unknown; from?: unknown }> = [];
    app.on('session.created', (event) => {
      created.push({ sessionId: event['sessionId'], from: event['from'] });
    });
    const env = await testStores();
    const direct = await app.create({ sessionId: 'direct', stores: env.stores });
    expect(direct.status().source).toBe('startup');
    expect(created).toEqual([]);
    const fresh = await app.open({});
    expect(fresh.status().source).toBe('startup');
    expect(created).toEqual([{ sessionId: fresh.sessionId, from: undefined }]);
    const live = await app.open({ sessionId: fresh.sessionId });
    expect(live).toBe(fresh);
    expect(live.status().source).toBe('startup');
    await app.close(fresh.sessionId);
    const resumed = await app.open({ sessionId: fresh.sessionId });
    expect(resumed.status().source).toBe('resume');
    expect(created).toHaveLength(1);
    const forked = await app.open({ from: fresh.sessionId });
    expect(forked.status().source).toBe('fork');
    expect(created).toEqual([
      { sessionId: fresh.sessionId, from: undefined },
      { sessionId: forked.sessionId, from: fresh.sessionId },
    ]);
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('deletes cold and live sessions and fires session.deleted on the app node', async () => {
    const space = memorySessionSpace();
    const app = createHarness({ space });
    const cold = await app.open({});
    await app.close(cold.sessionId);
    const live = await app.open({});
    const deleted: string[] = [];
    app.on('session.deleted', (event) => {
      deleted.push((event as unknown as { sessionId: string }).sessionId);
    });
    await app.delete(cold.sessionId);
    expect(await space.get(cold.sessionId)).toBeUndefined();
    expect(deleted).toEqual([cold.sessionId]);
    await app.delete(live.sessionId);
    expect(app.get(live.sessionId)).toBeUndefined();
    expect(live.state).toBe('unmounted');
    expect(await space.get(live.sessionId)).toBeUndefined();
    expect(deleted).toEqual([cold.sessionId, live.sessionId]);
    await expect(app.delete(live.sessionId)).rejects.toThrow(
      `session '${live.sessionId}' does not exist`,
    );
    expect(deleted).toEqual([cold.sessionId, live.sessionId]);
    await app.disposeAsync();
  });

  it('fires session.meta_updated on the app node for cold sessions without double-firing live ones', async () => {
    const space = memorySessionSpace();
    const app = createHarness({ space });
    const cold = await app.open({ title: 'cold' });
    await app.close(cold.sessionId);
    const live = await app.open({ title: 'live' });
    const seen: Array<{ sessionId: string; title?: string }> = [];
    app.on('session.meta_updated', (event) => {
      const payload = event as unknown as { sessionId: string; meta?: { title?: string } };
      seen.push({ sessionId: payload.sessionId, title: payload.meta?.title });
    });
    await app.updateSession(cold.sessionId, { title: 'cold-renamed' });
    expect(seen).toEqual([{ sessionId: cold.sessionId, title: 'cold-renamed' }]);
    expect((await space.get(cold.sessionId))?.title).toBe('cold-renamed');
    await app.updateSession(live.sessionId, { title: 'live-renamed' });
    expect(seen).toEqual([
      { sessionId: cold.sessionId, title: 'cold-renamed' },
      { sessionId: live.sessionId, title: 'live-renamed' },
    ]);
    await app.disposeAsync();
  });

  it('fires agent.opened with reopened discrimination and agent.closed on the session node', async () => {
    const env = await testStores();
    const app = createHarness({ features: [] });
    await app.ready();
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const opened: Array<{ agentId: string; source?: string; reopened?: boolean }> = [];
    const closed: string[] = [];
    session.on('agent.opened', (event) => {
      const payload = event as unknown as { agentId: string; source?: string; reopened?: boolean };
      opened.push({ agentId: payload.agentId, source: payload.source, reopened: payload.reopened });
    });
    session.on('agent.closed', (event) => {
      closed.push((event as unknown as { agentId: string }).agentId);
    });

    await session.create({ agentId: 'main', systemPrompt: 'main' });
    await session.create({ agentId: 'sub-1', source: 'spawn:main:coder' });
    await session.fork('main', { agentId: 'sub-2', source: 'btw' });
    await session.close('sub-1');
    await session.create({ agentId: 'sub-1' });

    expect(opened).toEqual([
      { agentId: 'main', source: undefined, reopened: undefined },
      { agentId: 'sub-1', source: 'spawn:main:coder', reopened: undefined },
      { agentId: 'sub-2', source: 'btw', reopened: undefined },
      { agentId: 'sub-1', source: 'spawn:main:coder', reopened: true },
    ]);
    expect(closed).toEqual(['sub-1']);
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('subscribes to sibling feature events at the app, session, and agent tiers', async () => {
    interface Ping extends RuntimeEvent {
      readonly type: 'pinger.ping';
      readonly sessionId: string;
      readonly agentId: string;
    }
    const PingerRef = createFacadeToken<{ ping(): void }>('test.pinger');
    const pinger = createFeature<Ping>('pinger', {
      agent() {
        const fire = useFire();
        useExpose(PingerRef, { ping: () => fire({ type: 'pinger.ping' }) });
      },
    });
    const seen: string[] = [];
    const listener = createFeature('listener', {
      app() {
        useOnApp(pinger, 'pinger.ping', (event) => {
          seen.push(`app:${event.sessionId}:${event.agentId}`);
        });
      },
      session() {
        useOnSession(pinger, 'pinger.ping', (event) => {
          seen.push(`session:${event.agentId}`);
        });
        useOnSession(pinger, '*', (event) => {
          seen.push(`any:${event.type}`);
        });
      },
      agent() {
        useOnAgent(pinger, 'pinger.ping', (event) => {
          seen.push(`agent:${event.agentId}`);
        });
      },
    });
    const envA = await testStores();
    const envB = await testStores();
    const app = createHarness({ features: [pinger, listener] });
    const left = await app.create({ sessionId: 'left', stores: envA.stores });
    const right = await app.create({ sessionId: 'right', stores: envB.stores });
    const leftAgent = await left.create({ agentId: 'main' });
    const rightAgent = await right.create({ agentId: 'main' });
    leftAgent.resolve(PingerRef)!.ping();
    expect(seen).toEqual(['agent:main', 'session:main', 'any:pinger.ping', 'app:left:main']);
    seen.length = 0;
    await app.close('left');
    const viaHandle: string[] = [];
    rightAgent.on(pinger, 'pinger.ping', (event) => {
      viaHandle.push(`handle:${event.agentId}`);
    });
    rightAgent.resolve(PingerRef)!.ping();
    expect(seen).toEqual(['agent:main', 'session:main', 'any:pinger.ping', 'app:right:main']);
    expect(viaHandle).toEqual(['handle:main']);
    await app.disposeAsync();
    await envA.stores.dispose();
    await envB.stores.dispose();
  });

  it('rejects a tier subscription without a matching tier ancestor', () => {
    const bad = createFeature('bad', {
      app() {
        useOnAgent('nope', () => {});
      },
    });
    expect(() => createHarness({ features: [bad] })).toThrow("no provider for token 'agent.node'");
  });
});
