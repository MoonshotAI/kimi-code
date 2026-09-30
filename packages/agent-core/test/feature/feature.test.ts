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
import { createUserEntry, createUserMessage, extractText, type HistoryMessage, type Message } from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { openSessionStores, type SessionStores } from '#/stores/session';
import { mountAgent, createHarness, type AgentHandle } from '#/app/index';
import {
  AgentPort,
  createFeature,
  useAgent,
  useAgentStore,
  useAgentTools,
  useSystemPrompt,
  useAfterTool,
  useAfterStep,
  useBeforeStep,
  useBeforeTool,
  useBeforeToolBatch,
  useToolPermission,
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
            agent.remind(createUserMessage('reminded'), { key: 'probe' });
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
    const app = createHarness({ features: [shared] });
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
      failing.on('turn.done', (event) => {
        const outcome = event.outcome;
        resolve(outcome.type === 'failed' && outcome.failure.reason === 'error' ? outcome.failure.error : undefined);
      });
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

  it('runs tool permission hooks after all before-tool hooks and sees the final tool call', async () => {
    const order: string[] = [];
    const executed: string[] = [];
    const spec = createFeature('perm', {
      agent() {
        useToolPermission(({ toolCall }) => {
          order.push(`permission:${toolCall.arguments ?? ''}`);
          if (toolCall.name === 'blocked') {
            return {
              type: 'denied',
              result: { content: [{ type: 'text', text: 'denied-by-permission' }] },
            };
          }
        });
        useBeforeTool(({ toolCall }) => {
          order.push('guard');
          if (toolCall.name === 'rewrite') {
            return { type: 'proceed', toolCall: { ...toolCall, arguments: '{"rewritten":true}' } };
          }
        });
        useAgentTools(
          {
            name: 'rewrite',
            description: 'rewrite probe',
            parameters: { type: 'object', properties: {} },
            execute: async ({ toolCall }) => {
              executed.push(toolCall.arguments ?? '');
              return { content: [{ type: 'text', text: 'ran' }] };
            },
          },
          {
            name: 'blocked',
            description: 'blocked probe',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              executed.push('blocked-ran');
              return { content: [{ type: 'text', text: 'nope' }] };
            },
          },
        );
      },
    });
    const env = await testStores();
    const requests: string[][] = [];
    const requester: LlmRequester = {
      generate: async (_config, content, { onEvent }) => {
        requests.push(content.messages.map((message) => extractText(message)));
        const last = content.messages.at(-1);
        const name = last !== undefined && last.role === 'user' ? extractText(last) : undefined;
        onEvent?.({ type: 'llm.streaming.part', part: name === 'rewrite' || name === 'blocked'
          ? { type: 'function', id: `call-${requests.length}`, name, arguments: '{}' }
          : { type: 'text', text: 'done' } });
        onEvent?.({ type: 'llm.done' });
      },
    };
    const app = createHarness({});
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'agent-0', features: shallowRef([spec]) });
    agent.setConfig({ model });
    agent.setRequester(requester);
    const first = turnDone(agent);
    agent.submit(createUserMessage('rewrite'));
    await first;
    const second = turnDone(agent);
    agent.submit(createUserMessage('blocked'));
    await second;
    expect(order).toEqual(['guard', 'permission:{"rewritten":true}', 'guard', 'permission:{}']);
    expect(executed).toEqual(['{"rewritten":true}']);
    expect(requests.at(-1)?.some((text) => text.includes('denied-by-permission'))).toBe(true);
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('runs batch hooks once and holds all execution until every before-hook settles', async () => {
    const order: string[] = [];
    let releaseAlpha!: () => void;
    const alphaGate = new Promise<void>((resolve) => { releaseAlpha = resolve; });
    const spec = createFeature('batch', {
      agent() {
        useBeforeToolBatch(({ toolCalls }) => {
          order.push(`batch:[${toolCalls.map((call) => call.name).join(',')}]`);
        });
        useBeforeTool(async (input) => {
          order.push(`before:${input.toolCall.name}:${'toolCalls' in input ? 'batch' : 'single'}`);
          if (input.toolCall.name === 'alpha') await alphaGate;
          order.push(`before-done:${input.toolCall.name}`);
        });
        useAgentTools(
          {
            name: 'alpha',
            description: 'alpha probe',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              order.push('exec:alpha');
              return { content: [{ type: 'text', text: 'a' }] };
            },
          },
          {
            name: 'beta',
            description: 'beta probe',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              order.push('exec:beta');
              return { content: [{ type: 'text', text: 'b' }] };
            },
          },
        );
      },
    });
    const env = await testStores();
    let call = 0;
    const requester: LlmRequester = {
      generate: async (_config, _content, { onEvent }) => {
        call += 1;
        if (call === 1) {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'function', id: 'call-1', name: 'alpha', arguments: '{}' } });
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'function', id: 'call-2', name: 'beta', arguments: '{}' } });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'done' } });
        }
        onEvent?.({ type: 'llm.done' });
      },
    };
    const app = createHarness({});
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'agent-0', features: shallowRef([spec]) });
    agent.setConfig({ model });
    agent.setRequester(requester);
    const done = turnDone(agent);
    agent.submit(createUserMessage('pair'));
    await vi.waitFor(() => { expect(order).toContain('before-done:beta'); });
    expect(order).not.toContain('exec:alpha');
    expect(order).not.toContain('exec:beta');
    releaseAlpha();
    await done;
    expect(order.filter((entry) => entry.startsWith('batch:'))).toEqual(['batch:[alpha,beta]']);
    expect(order).toContain('before:alpha:single');
    expect(order).toContain('before:beta:single');
    const lastBefore = Math.max(order.indexOf('before-done:alpha'), order.indexOf('before-done:beta'));
    const firstExec = Math.min(order.indexOf('exec:alpha'), order.indexOf('exec:beta'));
    expect(firstExec).toBeGreaterThan(-1);
    expect(lastBefore).toBeLessThan(firstExec);
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('denies the whole batch from a batch hook without running per-call hooks or executors', async () => {
    const seen: string[] = [];
    const spec = createFeature('batch-deny', {
      agent() {
        useBeforeToolBatch(({ toolCalls }) => {
          seen.push(`batch:[${toolCalls.map((call) => call.name).join(',')}]`);
          return {
            type: 'denied',
            result: { content: [{ type: 'text', text: 'batch-veto' }] },
          };
        });
        useBeforeTool(({ toolCall }) => {
          seen.push(`before:${toolCall.name}`);
        });
        useAgentTools(
          {
            name: 'alpha',
            description: 'alpha probe',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              seen.push('exec:alpha');
              return { content: [{ type: 'text', text: 'a' }] };
            },
          },
          {
            name: 'beta',
            description: 'beta probe',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              seen.push('exec:beta');
              return { content: [{ type: 'text', text: 'b' }] };
            },
          },
        );
      },
    });
    const env = await testStores();
    const requests: string[][] = [];
    const requester: LlmRequester = {
      generate: async (_config, content, { onEvent }) => {
        requests.push(content.messages.map((message) => extractText(message)));
        if (requests.length === 1) {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'function', id: 'call-1', name: 'alpha', arguments: '{}' } });
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'function', id: 'call-2', name: 'beta', arguments: '{}' } });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'done' } });
        }
        onEvent?.({ type: 'llm.done' });
      },
    };
    const app = createHarness({});
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'agent-0', features: shallowRef([spec]) });
    agent.setConfig({ model });
    agent.setRequester(requester);
    const done = turnDone(agent);
    agent.submit(createUserMessage('pair'));
    await done;
    expect(seen).toEqual(['batch:[alpha,beta]']);
    expect(requests).toHaveLength(2);
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('synthesizes aborted outcomes for the whole batch when aborted during preflight', async () => {
    let entered = false;
    let outcome: string | undefined;
    let toolMessages = 0;
    const executed: string[] = [];
    const spec = createFeature('batch-abort', {
      agent() {
        useBeforeTool(async () => {
          entered = true;
          await new Promise(() => {});
        });
        useAgentTools(
          {
            name: 'alpha',
            description: 'alpha probe',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              executed.push('alpha');
              return { content: [{ type: 'text', text: 'a' }] };
            },
          },
          {
            name: 'beta',
            description: 'beta probe',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              executed.push('beta');
              return { content: [{ type: 'text', text: 'b' }] };
            },
          },
        );
      },
    });
    const env = await testStores();
    let call = 0;
    const requester: LlmRequester = {
      generate: async (_config, _content, { onEvent }) => {
        call += 1;
        if (call === 1) {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'function', id: 'call-1', name: 'alpha', arguments: '{}' } });
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'function', id: 'call-2', name: 'beta', arguments: '{}' } });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'done' } });
        }
        onEvent?.({ type: 'llm.done' });
      },
    };
    const app = createHarness({});
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'agent-0', features: shallowRef([spec]) });
    agent.setConfig({ model });
    agent.setRequester(requester);
    agent.on('turn.done', (event) => {
      outcome = event.outcome.type;
      toolMessages = event.messages.filter((message) => message.message.role === 'tool').length;
    });
    agent.submit(createUserMessage('pair'));
    await vi.waitFor(() => { expect(entered).toBe(true); });
    agent.abort();
    await vi.waitFor(() => { expect(outcome).toBe('aborted'); });
    expect(executed).toEqual([]);
    expect(toolMessages).toBe(2);
    expect(call).toBe(1);
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

  it('runs afterStep hooks at the loop boundary and stops the turn normally on stopTurn', async () => {
    const env = await testStores();
    const requests: string[][] = [];
    const requester: LlmRequester = {
      generate: async (_config, content, { onEvent }) => {
        requests.push(content.messages.map((message) => extractText(message)));
        const last = content.messages.at(-1);
        onEvent?.({
          type: 'llm.streaming.part',
          part: last?.role === 'user'
            ? { type: 'function', id: `call-${requests.length}`, name: 'increment', arguments: '{}' }
            : { type: 'text', text: 'done' },
        });
        onEvent?.({ type: 'llm.done' });
      },
    };
    const seen: Array<{ step: number; final: boolean; texts: string[] }> = [];
    let stop = true;
    const spec = createFeature('after-step-probe', {
      agent() {
        useAgentTools({
          name: 'increment',
          description: 'increment',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text', text: 'count=1' }] }),
        });
        useAfterStep(({ step, final, messages }) => {
          seen.push({ step, final, texts: messages.map((entry) => extractText(entry.message)) });
          return stop ? { stopTurn: true } : undefined;
        });
      },
    });
    const app = createHarness({ features: [] });
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'agent-0', features: [spec] });
    agent.setConfig({ model });
    agent.setRequester(requester);
    const outcomes: string[] = [];
    agent.on('turn.done', (event) => { outcomes.push(event.outcome.type); });
    agent.submit(createUserMessage('run'));
    await vi.waitFor(() => { expect(outcomes).toEqual(['done']); });
    expect(requests).toHaveLength(1);
    expect(seen).toEqual([{ step: 1, final: false, texts: ['run', '', 'count=1'] }]);
    stop = false;
    agent.submit(createUserMessage('again'));
    await vi.waitFor(() => { expect(outcomes).toEqual(['done', 'done']); });
    expect(requests).toHaveLength(3);
    expect(seen).toEqual([
      { step: 1, final: false, texts: ['run', '', 'count=1'] },
      { step: 1, final: false, texts: ['run', '', 'count=1', 'again', '', 'count=1'] },
      { step: 2, final: true, texts: ['run', '', 'count=1', 'again', '', 'count=1', 'done'] },
    ]);
    await session.close('agent-0');
  });

  it('channels tool result isError into history meta and renders status blocks at request assembly', async () => {
    const env = await testStores();
    const requests: Message[][] = [];
    const requester: LlmRequester = {
      generate: async (_config, content, { onEvent }) => {
        requests.push([...content.messages]);
        const last = content.messages.at(-1);
        if (last?.role === 'user') {
          const calls: Array<[string, string]> = [
            ['call-fail', 'failer'],
            ['call-empty', 'emptier'],
            ['call-emptyfail', 'emptyFailer'],
            ['call-multi', 'multipart'],
            ['call-veto', 'vetoed'],
            ['call-ghost', 'ghost'],
          ];
          for (const [id, name] of calls) {
            onEvent?.({
              type: 'llm.streaming.part',
              part: { type: 'function', id, name, arguments: '{}' },
            });
          }
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'done' } });
        }
        onEvent?.({ type: 'llm.done' });
      },
    };
    let historyOf: () => readonly HistoryMessage[] = () => [];
    const spec = createFeature('iserror-probe', {
      agent() {
        const store = useAgentStore();
        historyOf = () => store.getState().history;
        useBeforeTool((input) =>
          input.toolCall.name === 'vetoed'
            ? {
                type: 'denied',
                result: { content: [{ type: 'text', text: 'vetoed by guard' }] },
              }
            : undefined,
        );
        useAgentTools(
          {
            name: 'failer',
            description: 'failer',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
          },
          {
            name: 'emptier',
            description: 'emptier',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [] }),
          },
          {
            name: 'emptyFailer',
            description: 'emptyFailer',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [], isError: true }),
          },
          {
            name: 'multipart',
            description: 'multipart',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({
              content: [
                { type: 'text', text: 'line1' },
                { type: 'image_url', imageUrl: { url: 'data:image/png;base64,x' } },
              ],
              isError: true,
            }),
          },
          {
            name: 'vetoed',
            description: 'vetoed',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'should not run' }] }),
          },
        );
      },
    });
    const app = createHarness({ features: [] });
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'agent-0', features: [spec] });
    agent.setConfig({ model });
    agent.setRequester(requester);
    const done = turnDone(agent);
    agent.submit(createUserMessage('go'));
    await done;
    await flush();
    const history = historyOf();
    const toolEntries = history.filter((entry) => entry.message.role === 'tool');
    expect(
      toolEntries.map((entry) => [entry.message.toolCallId, entry.meta?.isError === true]),
    ).toEqual([
      ['call-fail', true],
      ['call-empty', false],
      ['call-emptyfail', true],
      ['call-multi', true],
      ['call-veto', true],
      ['call-ghost', true],
    ]);
    expect(toolEntries.map((entry) => extractText(entry.message))).toEqual([
      'boom',
      '',
      '',
      'line1',
      'vetoed by guard',
      'unknown tool: ghost',
    ]);
    expect(toolEntries[3]?.message.content).toHaveLength(2);
    expect(requests).toHaveLength(2);
    const rendered = requests[1] ?? [];
    expect(rendered.map((message) => extractText(message))).toEqual([
      'go',
      '',
      '<system>ERROR: Tool execution failed.</system>\nboom',
      '<system>Tool output is empty.</system>',
      '<system>ERROR: Tool execution failed. Tool output is empty.</system>',
      '<system>ERROR: Tool execution failed.</system>line1',
      '<system>ERROR: Tool execution failed.</system>\nvetoed by guard',
      '<system>ERROR: Tool execution failed.</system>\nunknown tool: ghost',
    ]);
    const multiMessage = rendered.find((message) => message.role === 'tool' && message.toolCallId === 'call-multi');
    expect(multiMessage?.content[0]).toEqual({
      type: 'text',
      text: '<system>ERROR: Tool execution failed.</system>',
    });
    expect(multiMessage?.content[2]).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,x' },
    });
    await session.close('agent-0');
  });

  it('ends the turn normally when a tool result carries stopTurn, without short-circuiting the batch', async () => {
    const env = await testStores();
    const requests: string[][] = [];
    const requester: LlmRequester = {
      generate: async (_config, content, { onEvent }) => {
        requests.push(content.messages.map((message) => extractText(message)));
        const last = content.messages.at(-1);
        if (last?.role === 'user') {
          onEvent?.({
            type: 'llm.streaming.part',
            part: { type: 'function', id: 'call-stop', name: 'finisher', arguments: '{}' },
          });
          onEvent?.({
            type: 'llm.streaming.part',
            part: { type: 'function', id: 'call-plain', name: 'plain', arguments: '{}' },
          });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'done' } });
        }
        onEvent?.({ type: 'llm.done' });
      },
    };
    const executed: string[] = [];
    const spec = createFeature('stop-turn-probe', {
      agent() {
        useAgentTools(
          {
            name: 'finisher',
            description: 'finisher',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              executed.push('finisher');
              return { content: [{ type: 'text', text: 'finished' }], stopTurn: true };
            },
          },
          {
            name: 'plain',
            description: 'plain',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              executed.push('plain');
              return { content: [{ type: 'text', text: 'plain-ok' }] };
            },
          },
        );
      },
    });
    const app = createHarness({ features: [] });
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'agent-0', features: [spec] });
    agent.setConfig({ model });
    agent.setRequester(requester);
    const outcomes: string[] = [];
    agent.on('turn.done', (event) => { outcomes.push(event.outcome.type); });
    agent.submit(createUserMessage('run'));
    await vi.waitFor(() => { expect(outcomes).toEqual(['done']); });
    expect(requests).toHaveLength(1);
    expect([...executed].sort()).toEqual(['finisher', 'plain']);
    agent.submit(createUserMessage('again'));
    await vi.waitFor(() => { expect(outcomes).toEqual(['done', 'done']); });
    expect(requests).toEqual([
      ['run'],
      ['run', '', 'finished', 'plain-ok', 'again'],
    ]);
    await session.close('agent-0');
  });
});
