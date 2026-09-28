import { describe, expect, it, vi } from 'vitest';

import { createUserMessage, extractText, type SystemMessage } from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { openBlobs, type Blobs } from '#/store/blob';
import { MemoryBackend, Trees } from '#/store/tree';
import { openSessionStores, type RosterEntry, type SessionStores } from '#/stores/session';
import { createToken, inject, useExpose, useFire, ref, type Ref, type RuntimeEvent } from '#/kernel/index';
import { createFeature, useAgentTools, useBlobs, useSession, useSessionStore } from '#/feature/index';
import { mountApp, type AgentHandle } from '#/app/index';

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

const AppCounter = createToken<{ count: Ref<number> }>('test.appCounter');
const SessionCounter = createToken<{
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
        const appState = inject(AppCounter);
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
    const app = mountApp({ features: [appSpec, sessionSpec] });
    await app.ready();
    app.on(sessionSpec, 'session-probe.ready', (event) => {
      seen.push(event.sessionId);
    });
    app.resolve(AppCounter).count.value += 1;
    expect(app.resolve(AppCounter).count.value).toBe(1);
    const leftReady = app.wait(sessionSpec, 'session-probe.ready');
    const left = await app.create({ sessionId: 'left', stores: envA.stores });
    expect((await leftReady).sessionId).toBe('left');
    const rightReady = app.wait(sessionSpec, 'session-probe.ready');
    const right = await app.create({ sessionId: 'right', stores: envB.stores });
    expect((await rightReady).sessionId).toBe('right');
    expect(app.list()).toEqual(['left', 'right']);
    expect(app.get('left')).toBe(left);
    expect(seen).toEqual(['left', 'right']);
    expect(left.resolve(SessionCounter).blobs).toBe(envA.stores.blobs);
    expect(right.resolve(SessionCounter).blobs).toBe(envB.stores.blobs);
    left.resolve(SessionCounter).count.value += 1;
    expect(left.resolve(SessionCounter).count.value).toBe(1);
    expect(right.resolve(SessionCounter).count.value).toBe(0);
    expect(left.resolve(SessionCounter).appCount.value).toBe(1);
    expect(right.resolve(SessionCounter).appCount.value).toBe(1);
    const agent = await left.create({ agentId: 'agent-0' });
    agent.setConfig({ model });
    agent.setRequester(createEchoRequester());
    expect(left.resolve(SessionCounter).roster()).toEqual({
      'agent-0': { branch: 'agent-0', features: ['app-probe', 'session-probe'] },
    });
    expect(right.resolve(SessionCounter).roster()).toEqual({});
    const done = turnDone(agent);
    expect(agent.submit(createUserMessage('hello'))?.type).toBe('prompt.submitted');
    expect(await done).toContain('echo:hello');
    const store = envA.stores.get('agent-0');
    await envA.stores.flush();
    expect(store?.getState().history.some((entry) => extractText(entry.message) === 'echo:hello')).toBe(true);
    const ExtraCounter = createToken<{ count: Ref<number> }>('test.extraCounter');
    const extraSpec = createFeature('extra', {
      app() {
        useExpose(ExtraCounter, { count: ref(0) });
      },
    });
    app.installFeature(extraSpec);
    await app.ready();
    app.resolve(ExtraCounter).count.value = 7;
    expect(app.resolve(ExtraCounter).count.value).toBe(7);
    expect(() => app.installFeature(extraSpec)).toThrow('already installed');
    expect(app.uninstallFeature(extraSpec)).toBe(true);
    await app.ready();
    expect(() => app.resolve(ExtraCounter)).toThrow('no provider');
    app.installFeature(extraSpec);
    await app.ready();
    expect(app.resolve(ExtraCounter).count.value).toBe(0);
    expect(app.uninstallFeature('extra')).toBe(true);
    expect(app.uninstallFeature('extra')).toBe(false);
    await app.disposeAsync();
    expect(agent.state).toBe('unmounted');
    expect(left.state).toBe('unmounted');
    expect(app.list()).toEqual([]);
    await expect(agent.ready()).rejects.toThrow('unmounted');
    expect(() => app.resolve(AppCounter)).toThrow();
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
    const app = mountApp({ features: [spec] });
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main' });
    agent.setConfig({ model });
    agent.setRequester(requester);
    expect(session.list()).toEqual(['main']);
    expect(session.get('main')).toBe(agent);
    gate = Promise.withResolvers<void>();
    expect(agent.notify(createUserMessage('note'))?.type).toBe('prompt.notified');
    expect(agent.remind('rk', createUserMessage('reminder-text'))?.type).toBe('prompt.reminded');
    expect(agent.remind('sk', { role: 'system', content: [{ type: 'text', text: 'sys-reminder' }] } satisfies SystemMessage)?.type).toBe('prompt.reminded');
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
});
