import { describe, expect, it, vi } from 'vitest';

import { watch } from '@vue/reactivity';

import { openAgentStore, type AgentStore } from '#/stores/agent';
import { openBlobs } from '#/store/blob';
import { MemoryBackend, Trees, type BranchRef } from '#/store/tree';
import type { Projection } from '#/store/store';
import { treeJournal, type BranchJournal, type RecordEvent } from '#/store/journal';
import {
  computed,
  createToken,
  inject,
  useExpose,
  ref,
  shallowRef,
  type Ref,
} from '#/kernel/index';
import { createUserMessage, extractText } from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { openSessionStores, type SessionStores } from '#/stores/session';
import { mountAgent, mountApp, type AgentHandle } from '#/app/index';
import {
  createFeature,
  useAgent,
  useAgentStore,
  useAgentTools,
  useSystemPrompt,
  useAfterTool,
  useBeforeStep,
  useBeforeTool,
  useLlmRecovery,
  useLlmRetryable,
  useMessageResolver,
  usePromptGate,
} from '#/feature/index';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const model: LlmModel = { provider: 'test', model: 'test', capability: UNKNOWN_CAPABILITY };

function turnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => { resolve(); });
  });
}

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

describe('feature DSL', () => {
  it('installs feature tools, resolvers and step hooks into a real agent and withdraws them', async () => {
    const order: string[] = [];
    const Extra = createToken<string>('test.extra');
    const Calls = createToken<{
      calls: Ref<number>;
      steps: Ref<number>;
      finished: Ref<number>;
      befores: Ref<number>;
      afters: Ref<number>;
      gates: Ref<number>;
    }>('test.calls');
    const shared = createFeature('calls', {
      session() {
        const state = {
          calls: ref(0),
          steps: ref(0),
          finished: ref(0),
          befores: ref(0),
          afters: ref(0),
          gates: ref(0),
        };
        useExpose(Calls, state);
      },
    });
    const installed = shallowRef([createFeature('probe', {
      agent() {
        order.push('child-setup');
        expect(inject(Extra)).toBe('extra-value');
        const state = inject(Calls);
        const agent = useAgent();
        agent.on('turn.done', (event) => { state.finished.value += event.messages.length > 0 ? 1 : 0; });
        useBeforeStep(() => { state.steps.value += 1; });
        useBeforeTool(() => { state.befores.value += 1; });
        useAfterTool(({ result }) => {
          state.afters.value += 1;
          const text = result.content[0] && 'text' in result.content[0] ? result.content[0].text : '';
          return { content: [{ type: 'text', text: `${text}|hooked` }] };
        });
        usePromptGate(async () => {
          state.gates.value += 1;
          return false;
        });
        useLlmRecovery({ propose: () => undefined });
        useLlmRetryable(() => false);
        useMessageResolver({
          id: 'probe',
          resolve: async (messages) => [...messages, createUserMessage('resolved')],
        });
        useSystemPrompt(
          { id: 'probe', text: 'probe-section', priority: 10 },
          { id: 'early', text: 'early-section', priority: -1 },
          { id: 'empty', text: '' },
        );
        expect(() => useSystemPrompt({ id: 'host', text: 'stolen' })).toThrow(
          "system prompt section id 'host' is reserved",
        );
        expect(() => useSystemPrompt({ id: 'probe', text: 'dup' })).toThrow(
          "duplicate system prompt section: 'probe'",
        );
        expect(() => useSystemPrompt({ id: '  ', text: 'blank' })).toThrow(
          'system prompt section id must not be empty',
        );
        useAgentTools({
          name: 'increment',
          description: 'increment session calls',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            state.calls.value += 1;
            agent.notify(createUserMessage('notified'));
            agent.remind('probe', createUserMessage('reminded'));
            return { content: [{ type: 'text', text: `count=${state.calls.value}` }] };
          },
        });
      },
    })]);
    const env = await testStores();
    const requests: Array<{ tools: string[]; text: string[]; systemPrompt?: string }> = [];
    const requester: LlmRequester = {
      generate: async (_config, content, { onEvent }) => {
        requests.push({
          tools: content.tools?.map((tool) => tool.name) ?? [],
          text: content.messages.map((message) => extractText(message)),
          systemPrompt: content.systemPrompt,
        });
        onEvent?.({ type: 'llm.streaming.part', part: requests.length === 1
          ? { type: 'function', id: 'call-1', name: 'increment', arguments: '{}' }
          : { type: 'text', text: 'done' } });
        onEvent?.({ type: 'llm.done' });
      },
    };
    const app = mountApp({ features: [shared] });
    const session = await app.create({ sessionId: 'sess', stores: env.stores, requester });
    const state = session.node.resolve(Calls);
    const agent = await session.create({
      agentId: 'agent-0',
      request: { config: { model }, systemPrompt: 'host-text' },
      features: installed,
      provide: (node) => {
        order.push('provide');
        node.provide(Extra, 'extra-value');
      },
    });
    const first = turnDone(agent);
    agent.submit(createUserMessage('run'));
    await first;
    const store = env.stores.get('agent-0');
    await env.stores.flush();
    expect(order).toEqual(['provide', 'child-setup']);
    expect(state.calls.value).toBe(1);
    expect(state.steps.value).toBe(2);
    expect(state.finished.value).toBe(1);
    expect(state.befores.value).toBe(1);
    expect(state.afters.value).toBe(1);
    expect(state.gates.value).toBe(1);
    const assembledPrompt = 'host-text\n\nearly-section\n\nprobe-section';
    expect(requests).toEqual([
      { tools: ['increment'], text: ['run', 'resolved'], systemPrompt: assembledPrompt },
      { tools: ['increment'], text: ['run', '', 'count=1|hooked', 'notified', 'reminded', 'resolved'], systemPrompt: assembledPrompt },
    ]);
    expect(store?.getState().history.some((entry) => extractText(entry.message) === 'count=1|hooked')).toBe(true);
    installed.value = [createFeature('late', {
      agent() {
        useSystemPrompt({ id: 'late', text: 'should-not-appear' });
      },
    })];
    await session.ready();
    const second = turnDone(agent);
    agent.submit(createUserMessage('again'));
    await second;
    await vi.waitFor(() => { expect(requests).toHaveLength(3); });
    expect(requests[2]?.tools).toEqual([]);
    expect(requests[2]?.systemPrompt).toBe(assembledPrompt);
    expect(requests[2]?.text).not.toContain('resolved');
    expect(state.steps.value).toBe(2);
    expect(state.finished.value).toBe(1);
    expect(state.befores.value).toBe(1);
    expect(state.afters.value).toBe(1);
    expect(state.gates.value).toBe(1);
    const stepError = new Error('step rejected');
    installed.value = [createFeature('failing-step', {
      agent() { useBeforeStep(() => { throw stepError; }); },
    })];
    await session.ready();
    const failed = new Promise<unknown>((resolve) => {
      agent.on('turn.failed', (event) => resolve(event.failure.reason === 'error' ? event.failure.error : undefined));
    });
    agent.submit(createUserMessage('fail'));
    await expect(failed).resolves.toBe(stepError);
    expect(requests).toHaveLength(3);
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('folds durable state on join and commits atomic awaitable actions without false success', async () => {
    const trees = await Trees.open(new MemoryBackend().trees, {});
    const tree = await trees.tree('sess');
    tree.createBranch('main');
    let writeGate = Promise.resolve();
    let failWrite = false;
    const gated = (base: BranchJournal): BranchJournal => ({
      get branch() { return base.branch; },
      read: () => base.read(),
      append: (event) => writeGate.then(() => (failWrite ? Promise.reject(new Error('disk unavailable')) : base.append(event))),
      create: (branchName, from) => base.create(branchName, from),
      checkout: (branchName) => base.checkout(branchName),
      settled: () => base.settled(),
      close: () => base.close(),
    });
    const openGatedStore = async (): Promise<AgentStore> => {
      return openAgentStore(gated(treeJournal(tree, tree.openBranch('main'))));
    };
    interface CounterState {
      readonly count: number;
      readonly lastWriteTurn: number;
    }
    interface CounterFace {
      count: Ref<number>;
      lastWriteTurn: Ref<number>;
      write: (patch: Partial<CounterState>) => Promise<void>;
    }
    const Counter = createToken<CounterFace>('test.counter');
    const counter: Projection<CounterState, RecordEvent, BranchRef> = {
      initial: () => ({ count: 0, lastWriteTurn: 0 }),
      reduce: (current, event) => {
        if (event.type !== 'counter.updated') return current;
        const patch = event['patch'] as Partial<CounterState> | undefined;
        return patch === undefined ? current : { ...current, ...patch };
      },
    };
    const spec = createFeature('counter', {
      agent() {
        const store = useAgentStore();
        const state = store.fold(counter);
        useExpose(Counter, {
          count: computed(() => state.value.count),
          lastWriteTurn: computed(() => state.value.lastWriteTurn),
          write: (patch) => store.dispatch({ type: 'counter.updated', patch }).then(() => undefined),
        });
      },
    });
    const requester: LlmRequester = { generate: async () => {} };
    const installed = shallowRef([spec]);
    let store = await openGatedStore();
    const mount = () => mountAgent({
      store,
      sessionId: 'sess',
      agentId: 'agent-0',
      branchId: 'main',
      features: installed,
      requester,
      request: { config: { model } },
    });
    const first = mount();
    await first.ready();
    await first.node.resolve(Counter).write({ count: 3, lastWriteTurn: 1 });
    installed.value = [];
    await first.ready();
    expect(() => first.node.resolve(Counter)).toThrow('no provider');
    installed.value = [spec];
    await first.ready();
    expect([first.node.resolve(Counter).count.value, first.node.resolve(Counter).lastWriteTurn.value]).toEqual([3, 1]);
    await first.disposeAsync();
    const restored = mount();
    await restored.ready();
    const face = restored.node.resolve(Counter);
    expect([face.count.value, face.lastWriteTurn.value]).toEqual([3, 1]);
    const observations: number[][] = [];
    watch(() => [face.count.value, face.lastWriteTurn.value] as const, (state) => { observations.push([...state]); });
    const writing = Promise.withResolvers<void>();
    writeGate = writing.promise;
    let committed = false;
    const pendingWrite = face.write({ count: 5, lastWriteTurn: 2 }).then(() => { committed = true; });
    await flush();
    expect(committed).toBe(false);
    expect([face.count.value, face.lastWriteTurn.value]).toEqual([3, 1]);
    writing.resolve();
    await pendingWrite;
    expect([face.count.value, face.lastWriteTurn.value]).toEqual([5, 2]);
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((state) => state[0] === 5 && state[1] === 2)).toBe(true);
    failWrite = true;
    await expect(face.write({ count: 9, lastWriteTurn: 3 })).rejects.toThrow('disk unavailable');
    expect([face.count.value, face.lastWriteTurn.value]).toEqual([5, 2]);
    failWrite = false;
    await expect(face.write({ count: 99 })).rejects.toThrow('Store failed');
    await restored.disposeAsync();
    await store.close();
    store = await openGatedStore();
    const recovered = mount();
    await recovered.ready();
    const recoveredFace = recovered.node.resolve(Counter);
    expect([recoveredFace.count.value, recoveredFace.lastWriteTurn.value]).toEqual([5, 2]);
    await recoveredFace.write({ count: 6 });
    expect(recoveredFace.count.value).toBe(6);
    await recovered.disposeAsync();
    await store.close();
    store = await openGatedStore();
    const again = mount();
    await again.ready();
    expect([again.node.resolve(Counter).count.value, again.node.resolve(Counter).lastWriteTurn.value]).toEqual([6, 2]);
    await again.disposeAsync();
    await store.close();
  });
});
