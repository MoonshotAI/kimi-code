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
import { createUserEntry, createUserMessage, extractText } from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { openSessionStores, type SessionStores } from '#/stores/session';
import { mountAgent, mountApp, type AgentHandle } from '#/app/index';
import {
  AgentPort,
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
  useTurn,
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
    const Side = createToken<{
      enqueue: ReturnType<typeof useTurn>;
      calls: Ref<number>;
      maxActive: () => number;
    }>('test.side');
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
    const probeSpec = createFeature('probe', {
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
        let sideActive = 0;
        let sideMax = 0;
        const sideCalls = ref(0);
        const enqueue = useTurn({
          requester: {
            generate: async (_config, _content, { onEvent }) => {
              sideActive += 1;
              sideMax = Math.max(sideMax, sideActive);
              sideCalls.value += 1;
              await new Promise<void>((resolve) => setTimeout(resolve, 15));
              sideActive -= 1;
              onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'side' } });
              onEvent?.({ type: 'llm.done' });
            },
          },
          getConfig: () => ({ model }),
          getTools: () => [],
        });
        useExpose(Side, {
          enqueue,
          calls: sideCalls,
          maxActive: () => sideMax,
        });
      },
    });
    const installed = shallowRef([probeSpec]);
    const env = await testStores();
    const requests: Array<{ tools: string[]; text: string[]; systemPrompt?: string }> = [];
    const requester: LlmRequester = {
      generate: async (_config, content, { onEvent }) => {
        requests.push({
          tools: content.tools?.map((tool) => tool.name) ?? [],
          text: content.messages.map((message) => extractText(message)),
          systemPrompt: content.systemPrompt,
        });
        const last = content.messages.at(-1);
        const callsIncrement =
          requests.length === 1 ||
          (last !== undefined && last.role === 'user' && ['degraded', 'revive'].includes(extractText(last)));
        onEvent?.({ type: 'llm.streaming.part', part: callsIncrement
          ? { type: 'function', id: `call-${requests.length}`, name: 'increment', arguments: '{}' }
          : { type: 'text', text: 'done' } });
        onEvent?.({ type: 'llm.done' });
      },
    };
    const app = mountApp({ features: [shared] });
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const state = session.resolve(Calls);
    const agent = await session.create({
      agentId: 'agent-0',
      systemPrompt: 'host-text',
      features: installed,
      provide: (node) => {
        order.push('provide');
        node.provide(Extra, 'extra-value');
      },
    });
    agent.setConfig({ model });
    agent.setRequester(requester);
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
    const side = agent.resolve(Side);
    const sideHistory = [createUserEntry(createUserMessage('side'), { source: 'input' })];
    const [left, right] = await Promise.all([
      side.enqueue({ history: sideHistory, maxSteps: 1 }),
      side.enqueue({ history: sideHistory, maxSteps: 1 }),
    ]);
    expect(left.type).toBe('done');
    expect(right.type).toBe('done');
    expect(side.calls.value).toBe(2);
    expect(side.maxActive()).toBe(1);
    expect(requests).toHaveLength(2);
    const lateSpec = createFeature('late', {
      agent() {
        useSystemPrompt({ id: 'late', text: 'should-not-appear' });
      },
    });
    installed.value = [lateSpec];
    await session.ready();
    const second = turnDone(agent);
    agent.submit(createUserMessage('again'));
    await second;
    await vi.waitFor(() => { expect(requests).toHaveLength(3); });
    expect(requests[2]?.tools).toEqual(['increment']);
    expect(requests[2]?.systemPrompt).toBe(assembledPrompt);
    expect(requests[2]?.text).toContain('resolved');
    expect(state.steps.value).toBe(3);
    expect(state.finished.value).toBe(2);
    await session.close('agent-0');
    expect(() => agent.resolve(Side)).toThrow('no provider');
    const resumed = await session.create({
      agentId: 'agent-0',
      systemPrompt: 'host-text',
      features: [probeSpec, lateSpec],
      provide: (node) => {
        node.provide(Extra, 'extra-value');
      },
    });
    resumed.setConfig({ model });
    resumed.setRequester(requester);
    const third = turnDone(resumed);
    resumed.submit(createUserMessage('resume'));
    await third;
    await vi.waitFor(() => { expect(requests).toHaveLength(4); });
    expect(requests[3]?.tools).toEqual(['increment']);
    expect(requests[3]?.systemPrompt).toBe(assembledPrompt);
    expect(requests[3]?.text).toContain('resolved');
    expect(state.steps.value).toBe(4);
    const stepError = new Error('step rejected');
    const failing = await session.create({
      agentId: 'agent-1',
      features: [createFeature('failing-step', {
        agent() { useBeforeStep(() => { throw stepError; }); },
      })],
    });
    failing.setConfig({ model });
    failing.setRequester(requester);
    const failed = new Promise<unknown>((resolve) => {
      failing.on('turn.failed', (event) => resolve(event.failure.reason === 'error' ? event.failure.error : undefined));
    });
    failing.submit(createUserMessage('fail'));
    await expect(failed).resolves.toBe(stepError);
    expect(requests).toHaveLength(4);
    const missing: string[] = [];
    session.on('session.feature_missing', (event) => {
      missing.push(event['featureName'] as string);
    });
    await session.close('agent-0');
    const degraded = await session.create({ agentId: 'agent-0', systemPrompt: 'host-text' });
    expect(missing).toEqual(['probe']);
    degraded.setConfig({ model });
    degraded.setRequester(requester);
    const fourth = turnDone(degraded);
    degraded.submit(createUserMessage('degraded'));
    await fourth;
    await vi.waitFor(() => { expect(requests).toHaveLength(6); });
    expect(requests[4]?.tools).toEqual(['increment']);
    expect(requests[4]?.systemPrompt).toBe(assembledPrompt);
    expect(requests[5]?.text.some((text) => text.includes("tool 'increment' is unavailable"))).toBe(true);
    degraded.resolve(AgentPort).registerToolExecutor('increment', {
      execute: async () => ({ content: [{ type: 'text', text: 'revived' }] }),
    });
    const fifth = turnDone(degraded);
    degraded.submit(createUserMessage('revive'));
    await fifth;
    await vi.waitFor(() => { expect(requests).toHaveLength(8); });
    expect(requests[6]?.tools).toEqual(['increment']);
    expect(requests[7]?.text.some((text) => text.includes('revived'))).toBe(true);
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
    const mount = () => {
      const handle = mountAgent({
        store,
        sessionId: 'sess',
        agentId: 'agent-0',
        branchId: 'main',
        features: installed,
      });
      handle.setConfig({ model });
      handle.setRequester(requester);
      return handle;
    };
    const first = mount();
    await first.ready();
    await first.resolve(Counter).write({ count: 3, lastWriteTurn: 1 });
    installed.value = [];
    await first.ready();
    expect(() => first.resolve(Counter)).toThrow('no provider');
    installed.value = [spec];
    await first.ready();
    expect([first.resolve(Counter).count.value, first.resolve(Counter).lastWriteTurn.value]).toEqual([3, 1]);
    await first.disposeAsync();
    const restored = mount();
    await restored.ready();
    const face = restored.resolve(Counter);
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
    const recoveredFace = recovered.resolve(Counter);
    expect([recoveredFace.count.value, recoveredFace.lastWriteTurn.value]).toEqual([5, 2]);
    await recoveredFace.write({ count: 6 });
    expect(recoveredFace.count.value).toBe(6);
    await recovered.disposeAsync();
    await store.close();
    store = await openGatedStore();
    const again = mount();
    await again.ready();
    expect([again.resolve(Counter).count.value, again.resolve(Counter).lastWriteTurn.value]).toEqual([6, 2]);
    await again.disposeAsync();
    await store.close();
  });
});
