import { describe, expect, it, vi } from 'vitest';

import { createUserMessage, extractText, type SystemMessage } from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { openBlobs, type Blobs } from '#/store/blob';
import { MemoryBackend, Trees } from '#/store/tree';
import { openSessionStores, type SessionStores } from '#/stores/session';
import { createToken, inject, useExpose, ref, type Ref } from '#/kernel/index';
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
  roster(): Record<string, string>;
  blobs: Blobs;
}>('test.sessionCounter');

describe('app-session-agent units', () => {
  it('assembles the three-tier unit tree and runs a real turn with isolated session features', async () => {
    const envA = await testStores();
    const envB = await testStores();
    const bridged: string[] = [];
    const appSpec = createFeature('app-probe', {
      app() {
        useExpose(AppCounter, { count: ref(0) });
      },
    });
    const sessionSpec = createFeature('session-probe', {
      session() {
        const appState = inject(AppCounter);
        const sessionStore = useSessionStore();
        useExpose(SessionCounter, {
          count: ref(0),
          appCount: appState.count,
          roster: () => sessionStore.getState().roster.agents,
          blobs: useBlobs(),
        });
        bridged.push(useSession().sessionId);
      },
    });
    const app = mountApp({ features: [appSpec, sessionSpec] });
    await app.ready();
    app.node.resolve(AppCounter).count.value += 1;
    expect(app.node.resolve(AppCounter).count.value).toBe(1);
    const left = await app.create({ sessionId: 'left', stores: envA.stores, requester: createEchoRequester() });
    const right = await app.create({ sessionId: 'right', stores: envB.stores, requester: createEchoRequester() });
    expect(app.list()).toEqual(['left', 'right']);
    expect(app.get('left')).toBe(left);
    expect(bridged).toEqual(['left', 'right']);
    expect(left.node.resolve(SessionCounter).blobs).toBe(envA.stores.blobs);
    expect(right.node.resolve(SessionCounter).blobs).toBe(envB.stores.blobs);
    left.node.resolve(SessionCounter).count.value += 1;
    expect(left.node.resolve(SessionCounter).count.value).toBe(1);
    expect(right.node.resolve(SessionCounter).count.value).toBe(0);
    expect(left.node.resolve(SessionCounter).appCount.value).toBe(1);
    expect(right.node.resolve(SessionCounter).appCount.value).toBe(1);
    const agent = await left.create({ agentId: 'agent-0', request: { config: { model } } });
    expect(left.node.resolve(SessionCounter).roster()).toEqual({ 'agent-0': 'agent-0' });
    expect(right.node.resolve(SessionCounter).roster()).toEqual({});
    const done = turnDone(agent);
    agent.submit(createUserMessage('hello'));
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
    app.node.resolve(ExtraCounter).count.value = 7;
    expect(app.node.resolve(ExtraCounter).count.value).toBe(7);
    expect(() => app.installFeature(extraSpec)).toThrow('already installed');
    expect(app.uninstallFeature(extraSpec)).toBe(true);
    await app.ready();
    expect(() => app.node.resolve(ExtraCounter)).toThrow('no provider');
    app.installFeature(extraSpec);
    await app.ready();
    expect(app.node.resolve(ExtraCounter).count.value).toBe(0);
    expect(app.uninstallFeature('extra')).toBe(true);
    expect(app.uninstallFeature('extra')).toBe(false);
    await app.disposeAsync();
    expect(agent.state).toBe('unmounted');
    expect(left.state).toBe('unmounted');
    expect(app.list()).toEqual([]);
    await expect(agent.ready()).rejects.toThrow('unmounted');
    expect(() => app.node.resolve(AppCounter)).toThrow();
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
    const session = await app.create({ sessionId: 'sess', stores: env.stores, requester });
    const agent = await session.create({ agentId: 'main', request: { config: { model } } });
    expect(session.list()).toEqual(['main']);
    expect(session.get('main')).toBe(agent);
    gate = Promise.withResolvers<void>();
    agent.notify(createUserMessage('note'));
    agent.remind('rk', createUserMessage('reminder-text'));
    agent.remind('sk', { role: 'system', content: [{ type: 'text', text: 'sys-reminder' }] } satisfies SystemMessage);
    const first = turnDone(agent);
    agent.submit(createUserMessage('go'));
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
    agent.cancel('p2');
    gate.resolve();
    await second;
    expect(requests).toHaveLength(4);
    expect(requests.flat()).not.toContain('p2');
    const store = env.stores.get('main');
    await env.stores.flush();
    expect(store?.getState().history.some((entry) => extractText(entry.message) === 'note')).toBe(true);
    const copy = await session.fork('main', { agentId: 'copy', request: { config: { model } } });
    expect(session.list()).toEqual(['main', 'copy']);
    const copyStore = env.stores.get('copy');
    expect(copyStore?.getState().history.some((entry) => extractText(entry.message) === 'go')).toBe(true);
    await session.close('main');
    expect(session.list()).toEqual(['copy']);
    const sessionLog = env.stores.session;
    expect(Object.keys(sessionLog.getState().roster.agents)).toEqual(['copy']);
    await app.close('sess');
    expect(app.list()).toEqual([]);
    expect(session.state).toBe('unmounted');
    expect(copy.state).toBe('unmounted');
    await env.stores.dispose();
  });
});
