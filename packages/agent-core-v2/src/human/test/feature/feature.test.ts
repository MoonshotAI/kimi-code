import { describe, expect, it } from 'vitest';

import type { AnyEventObject } from '#/xstate2';

import type { AgentEvent, AgentMachineSelf } from '#/agent/machine';
import { agentSlices, type AgentEventStore } from '#/agent/slices';
import { createEventStoreSync } from '#/eventStore/eventStore';
import { memoryJournal } from '#/eventStore/journal';
import {
  createStore,
  createToken,
  createUnit,
  inject,
  isStoreRecipe,
  ref,
  shallowRef,
  useDurable,
  type StoreResolution,
} from '#/kernel/index';
import { createUserMessage, type SystemMessage } from '#/llm/message';
import type { ToolDefinition } from '#/tool/tool';
import {
  AgentContext,
  AgentRuntime,
  createFeature,
  createTool,
  isToolRecipe,
  mountAgentFeatures,
  slotEntries,
  type FeatureToolSink,
} from '#/feature/index';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function testStore(): AgentEventStore {
  return createEventStoreSync({ journal: memoryJournal(), slices: agentSlices });
}

function fakeSelf(): {
  self: AgentMachineSelf;
  sent: AgentEvent[];
  emit: (type: string, event: AnyEventObject) => void;
} {
  const sent: AgentEvent[] = [];
  const handlers = new Map<string, Array<(emitted: AnyEventObject) => void>>();
  const self: AgentMachineSelf = {
    send: (event) => {
      sent.push(event);
    },
    getSnapshot: () => ({}),
    on: (type, handler) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return {
        unsubscribe: () => {
          const index = list.indexOf(handler);
          if (index >= 0) list.splice(index, 1);
        },
      };
    },
  };
  return {
    self,
    sent,
    emit: (type, event) => {
      for (const handler of handlers.get(type) ?? []) handler(event);
    },
  };
}

describe('feature DSL', () => {
  it('assembles FeatureSpec from store, tool and unit recipes and keys slot entries per tier', () => {
    const counterStore = createStore('counter', () => ({ count: ref(0) }));
    const echoTool = createTool(
      'echo',
      { description: 'echo back', parameters: { type: 'object', properties: {} } },
      () => ({ execute: async () => ({ content: [] }) }),
    );
    const watcher = createUnit('watcher', () => {});
    const factory = createFeature<{ seed: number }>(
      'demo',
      { agent: [counterStore, echoTool], session: watcher },
      { handle: counterStore },
    );

    const spec = factory({ seed: 1 });

    expect(spec.featureName).toBe('demo');
    expect(spec.props).toEqual({ seed: 1 });
    expect(spec.handle).toBe(counterStore);
    expect(isStoreRecipe(counterStore)).toBe(true);
    expect(counterStore.storeName).toBe('counter');
    expect(isToolRecipe(echoTool)).toBe(true);
    expect(echoTool.toolName).toBe('echo');
    expect(echoTool.meta.description).toBe('echo back');
    expect(slotEntries(spec, 'agent').map((entry) => entry.key)).toEqual([
      'demo:store:counter',
      'demo:tool:echo',
    ]);
    expect(slotEntries(spec, 'agent')[0]?.props).toEqual({ seed: 1 });
    expect(slotEntries(spec, 'session').map((entry) => entry.key)).toEqual(['demo:watcher']);
    expect(slotEntries(spec, 'app')).toEqual([]);
  });

  it('bridges AgentRuntime on/notify/remind to the agent actor', () => {
    const { self, sent, emit } = fakeSelf();
    const seen: unknown[] = [];
    const probe = createUnit('probe', () => {
      const runtime = inject(AgentRuntime);
      runtime.on('turn.done', (event) => {
        seen.push(event);
      });
      runtime.notify(createUserMessage('hello'));
      runtime.remind('user-key', createUserMessage('user-remind'));
      runtime.remind('sys-key', { role: 'system', content: [{ type: 'text', text: 'sys-remind' }] } satisfies SystemMessage);
    });
    mountAgentFeatures({
      self,
      store: testStore(),
      sessionId: 'sess',
      agentId: 'agent-0',
      features: [createFeature('probe', { agent: probe })()],
    });

    const doneEvent = { type: 'turn.done', messages: [], branchId: 'main' };
    emit('turn.done', doneEvent);

    expect(seen).toEqual([doneEvent]);
    expect(sent).toEqual([
      { type: 'input.notify', entry: { message: createUserMessage('hello') } },
      {
        type: 'input.remind',
        key: 'user-key',
        entry: { message: createUserMessage('user-remind'), meta: {} },
      },
      {
        type: 'input.remind',
        key: 'sys-key',
        entry: {
          message: { role: 'system', content: [{ type: 'text', text: 'sys-remind' }] },
          meta: {},
        },
      },
    ]);
  });

  it('provides composition-root values before feature children mount', () => {
    const order: string[] = [];
    const Extra = createToken<string>('test.extra');
    const probe = createUnit('probe', () => {
      order.push('child-setup');
      expect(inject(Extra)).toBe('extra-value');
      expect(inject(AgentContext)).toEqual({ sessionId: 'sess', agentId: 'agent-0' });
    });
    mountAgentFeatures({
      self: fakeSelf().self,
      store: testStore(),
      sessionId: 'sess',
      agentId: 'agent-0',
      features: [createFeature('probe', { agent: probe })()],
      provide: (node) => {
        order.push('provide');
        node.provide(Extra, 'extra-value');
      },
    });
    expect(order).toEqual(['provide', 'child-setup']);
  });

  it('folds feature tool definitions into the sink and diffs them as the features source changes', async () => {
    const registered: ToolDefinition[] = [];
    const unregistered: string[] = [];
    const sink: FeatureToolSink = {
      register: (definition) => {
        registered.push(definition);
        return () => {
          unregistered.push(definition.name);
        };
      },
    };
    const echoTool = createTool(
      'echo',
      { description: 'echo back', parameters: { type: 'object', properties: {} } },
      () => ({
        execute: async () => ({ content: [{ type: 'text', text: 'echo!' }] }),
      }),
    );
    const source = shallowRef([createFeature('echo', { agent: echoTool })()]);
    mountAgentFeatures({
      self: fakeSelf().self,
      store: testStore(),
      sessionId: 'sess',
      agentId: 'agent-0',
      features: source,
      toolSink: sink,
    });

    expect(registered.map((definition) => definition.name)).toEqual(['echo']);
    const definition = registered[0] as ToolDefinition;
    expect(definition.description).toBe('echo back');
    const result = await definition.execute({
      toolCall: { type: 'function', id: 'call-1', name: 'echo', arguments: '{}' },
      signal: new AbortController().signal,
    });
    expect(result.content).toEqual([{ type: 'text', text: 'echo!' }]);

    source.value = [];
    await flush();
    expect(unregistered).toEqual(['echo']);
  });

  it('routes useDurable patches through the agent event store backend', async () => {
    const store = testStore();
    interface CounterFace {
      count: Ref<number>;
    }
    const counterStore = createStore<CounterFace>('counter', () => {
      const count = useDurable('count', 0);
      return { count };
    });
    let sibling: StoreResolution<CounterFace> | undefined;
    const consumer = createUnit('consumer', () => {
      sibling = inject(counterStore);
    });
    mountAgentFeatures({
      self: fakeSelf().self,
      store,
      sessionId: 'sess',
      agentId: 'agent-0',
      features: [createFeature('counter', { agent: [counterStore, consumer] })()],
    });

    expect(sibling?.count.value).toBe(0);
    sibling!.count.value = 3;
    await flush();
    await flush();
    await flush();

    const state = store.getState() as unknown as Record<string, Record<string, unknown>>;
    expect(state['store:counter']).toEqual({ count: 3 });
  });
});
