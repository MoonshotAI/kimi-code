import { describe, expect, it } from 'vitest';

import type { AnyEventObject } from '#/xstate2';

import type { AgentEvent, AgentMachineSelf } from '#/agent/machine';
import { agentSlices, type AgentEventStore } from '#/agent/slices';
import { createEventStoreSync, memoryJournal } from '#/store/log';
import { createStore, isStoreRecipe, useDurable } from '#/store/index';
import { createToken, createUnit, inject, ref } from '#/kernel/index';
import { createUserMessage, type SystemMessage } from '#/llm/message';
import {
  AgentContext,
  AgentRuntime,
  createFeature,
  mountAgentFeatures,
  slotEntries,
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
  it('owns isolated agent features beneath session features and awaits their lifecycle', async () => {
    const { mountSessionFeatures } = await import('#/feature/index');
    const { useReady } = await import('#/kernel/index');
    const closed: string[] = [];
    const sessionInitialized = Promise.withResolvers<void>();
    const sessionStore = createStore('session-counter', () => {
      const count = ref(0);
      useReady(sessionInitialized.promise.then(() => { count.value = 10; }));
      return { count };
    });
    const counterStore = createStore('counter', () => {
      const session = inject(sessionStore);
      expect(session.count.value).toBe(10);
      const count = ref(0);
      return {
        count,
        increment: () => {
          count.value += 1;
          session.count.value += 1;
        },
      };
    });
    const initialized = Promise.withResolvers<void>();
    const watcher = createUnit<{ seed: number }>('watcher', (props) => {
      const counter = inject(counterStore);
      useReady(initialized.promise.then(() => { counter.count.value = props.seed; }));
      return async () => {
        await Promise.resolve();
        closed.push('agent');
      };
    });
    const sessionCleanup = createUnit('session-cleanup', () => () => { closed.push('session'); });
    const shared = createFeature('shared', { session: [sessionStore, sessionCleanup] }, { handle: sessionStore })();
    const spec = createFeature<{ seed: number }, ReturnType<typeof counterStore.setup>>(
      'demo',
      { agent: [counterStore, watcher] },
      { handle: counterStore },
    )({ seed: 1 });
    const first = mountSessionFeatures({ sessionId: 'first', features: [shared, spec] });
    const second = mountSessionFeatures({ sessionId: 'second', features: [shared, spec] });
    const left = first.mountAgent({ self: fakeSelf().self, store: testStore(), agentId: 'left' });
    const right = first.mountAgent({ self: fakeSelf().self, store: testStore(), agentId: 'right' });
    const isolated = second.mountAgent({ self: fakeSelf().self, store: testStore(), agentId: 'isolated' });
    let ready = false;
    const pending = first.ready().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    sessionInitialized.resolve();
    initialized.resolve();
    await pending;
    await second.ready();
    left.get(spec).increment();
    expect(left.get(spec).count.value).toBe(2);
    expect(right.get(spec).count.value).toBe(1);
    expect(isolated.get(spec).count.value).toBe(1);
    expect(first.get(shared).count.value).toBe(11);
    expect(second.get(shared).count.value).toBe(10);
    expect(isStoreRecipe(counterStore)).toBe(true);
    expect(slotEntries(spec, 'agent').map((entry) => entry.key)).toEqual(['demo:store:counter', 'demo:watcher']);
    expect(slotEntries(spec, 'agent')[1]?.props).toEqual({ seed: 1 });
    expect(slotEntries(spec, 'app')).toEqual([]);
    const retained = left.get(spec);
    await first.disposeAsync();
    expect(closed).toEqual(['agent', 'agent', 'session']);
    expect(() => retained.increment()).toThrow('unmounted');
    expect(() => first.mountAgent({ self: fakeSelf().self, store: testStore(), agentId: 'late' })).toThrow('unmounted');
    await second.disposeAsync();
  });

  it('bridges typed events and releases subscriptions and initialization on early disposal', async () => {
    const { useReady } = await import('#/kernel/index');
    const { self, sent, emit } = fakeSelf();
    const seen: unknown[] = [];
    const pending = Promise.withResolvers<void>();
    const probe = createUnit('probe', () => {
      const runtime = inject(AgentRuntime);
      useReady(pending.promise);
      runtime.on('turn.done', (event) => {
        seen.push(event);
      });
      runtime.notify(createUserMessage('hello'));
      runtime.remind('user-key', createUserMessage('user-remind'));
      runtime.remind('sys-key', { role: 'system', content: [{ type: 'text', text: 'sys-remind' }] } satisfies SystemMessage);
      return () => pending.resolve();
    });
    const host = mountAgentFeatures({
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
    await host.disposeAsync();
    emit('turn.done', doneEvent);
    expect(seen).toEqual([doneEvent]);
    await expect(host.ready()).rejects.toThrow('unmounted');
    const { createAgentScopeFactory } = await import('#/feature/index');
    const original = new Error('initialization failed');
    const broken = createFeature('broken', { agent: createUnit('broken', () => {
      useReady(Promise.reject(original));
      return () => { throw new Error('cleanup failed'); };
    }) })();
    const factory = createAgentScopeFactory({
      store: testStore(), sessionId: 'sess', agentId: 'broken', features: [broken],
      requester: { generate: async () => {} },
    });
    await expect(factory(fakeSelf().self, new AbortController().signal)).rejects.toMatchObject({
      message: 'initialization failed', cause: original,
    });
    const { mountSessionFeatures } = await import('#/feature/index');
    let parentDisposed = false;
    const waitingSession = mountSessionFeatures({ sessionId: 'waiting', features: [createFeature('waiting', {
      session: createUnit('waiting', () => {
        useReady(new Promise<void>(() => {}));
        return () => { parentDisposed = true; };
      }),
    })()] });
    const child = waitingSession.mountAgent({ self: fakeSelf().self, store: testStore(), agentId: 'child' });
    const childReady = expect(child.ready()).rejects.toThrow('unmounted');
    await child.disposeAsync();
    await childReady;
    expect(child.state).toBe('unmounted');
    expect(waitingSession.state).toBe('active');
    expect(parentDisposed).toBe(false);
    await waitingSession.disposeAsync();
    expect(parentDisposed).toBe(true);
  });

  it('installs feature tools, resolvers and step hooks into a real agent and withdraws them', async () => {
    const { createActor, waitFor } = await import('#/xstate2');
    const { createAgentMachine } = await import('#/agent/machine');
    const { UNKNOWN_CAPABILITY } = await import('#/llm/capability');
    const { extractText } = await import('#/llm/message');
    const { shallowRef } = await import('#/kernel/index');
    const { createAgentScopeFactory, mountSessionFeatures, useAgentTools, useMessageResolver, useBeforeStep } = await import('#/feature/index');
    const order: string[] = [];
    const Extra = createToken<string>('test.extra');
    const sessionStore = createStore('calls', () => ({ calls: ref(0), steps: ref(0), finished: ref(0) }));
    const probe = createUnit('probe', () => {
      order.push('child-setup');
      expect(inject(Extra)).toBe('extra-value');
      expect(inject(AgentContext)).toEqual({ sessionId: 'sess', agentId: 'agent-0' });
      const state = inject(sessionStore);
      const runtime = inject(AgentRuntime);
      runtime.on('turn.done', (event) => { state.finished.value += event.messages.length > 0 ? 1 : 0; });
      useBeforeStep(() => { state.steps.value += 1; });
      useMessageResolver({
        id: 'probe',
        resolve: async (messages) => [...messages, createUserMessage('resolved')],
      });
      useAgentTools({
        name: 'increment',
        description: 'increment session calls',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          state.calls.value += 1;
          runtime.notify(createUserMessage('notified'));
          runtime.remind('probe', createUserMessage('reminded'));
          return { content: [{ type: 'text', text: `count=${state.calls.value}` }] };
        },
      });
    });
    const shared = createFeature('calls', { session: sessionStore }, { handle: sessionStore })();
    const installed = shallowRef([createFeature('probe', { agent: probe })()]);
    const session = mountSessionFeatures({ sessionId: 'sess', features: [shared] });
    const requests: Array<{ tools: string[]; text: string[] }> = [];
    const requester: import('#/llm/requester/requester').LlmRequester = {
      generate: async (config, content, { onEvent }) => {
        requests.push({ tools: config.tools?.map((tool) => tool.name) ?? [], text: content.messages.map((message) => extractText(message)) });
        onEvent?.({ type: 'llm.streaming.part', part: requests.length === 1
          ? { type: 'function', id: 'call-1', name: 'increment', arguments: '{}' }
          : { type: 'text', text: 'done' } });
        onEvent?.({ type: 'llm.done' });
      },
    };
    const store = testStore();
    const actor = createActor(createAgentMachine({}), { input: {
      request: { model: { provider: 'test', model: 'test', capability: UNKNOWN_CAPABILITY } },
      scopeFactory: createAgentScopeFactory({
        session, store, requester, agentId: 'agent-0', features: installed,
        provide: (node) => { order.push('provide'); node.provide(Extra, 'extra-value'); },
      }),
    } });
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('run') } });
    await waitFor(actor, (snapshot) => snapshot.matches('idle') && session.get(shared).finished.value === 1);
    await store.flush();
    expect(order).toEqual(['provide', 'child-setup']);
    expect(session.get(shared).calls.value).toBe(1);
    expect(session.get(shared).steps.value).toBe(2);
    expect(requests).toEqual([
      { tools: ['increment'], text: ['run', 'resolved'] },
      { tools: ['increment'], text: ['run', '', 'count=1', 'notified', 'reminded', 'resolved'] },
    ]);
    expect(store.getState().history.some((entry) => extractText(entry.message) === 'count=1')).toBe(true);
    installed.value = [];
    await session.ready();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('again') } });
    await waitFor(actor, (snapshot) => snapshot.matches('idle') && requests.length === 3);
    expect(requests[2]?.tools).toEqual([]);
    expect(requests[2]?.text).not.toContain('resolved');
    expect(session.get(shared).steps.value).toBe(2);
    expect(session.get(shared).finished.value).toBe(1);
    const stepError = new Error('step rejected');
    installed.value = [createFeature('failing-step', { agent: createUnit('failing-step', () => {
      useBeforeStep(() => { throw stepError; });
    }) })()];
    const failed = new Promise<unknown>((resolve) => { actor.on('turn.failed', (event) => resolve(event.error)); });
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('fail') } });
    await expect(failed).resolves.toBe(stepError);
    expect(requests).toHaveLength(3);
    actor.send({ type: 'input.close' });
    await waitFor(actor, (snapshot) => snapshot.status === 'done');
    await session.disposeAsync();
  });

  it('restores durable features before ready and commits atomic awaitable actions without false success', async () => {
    const { useDurableAction } = await import('#/store/index');
    const journal = memoryJournal();
    let restoreGate = Promise.resolve();
    let writeGate = Promise.resolve();
    let failWrite = false;
    const persistence = {
      ...journal,
      read: async function* () { await restoreGate; yield* journal.read(); },
      append: async (input: Parameters<typeof journal.append>[0]) => {
        await writeGate;
        if (failWrite) throw new Error('disk unavailable');
        return journal.append(input);
      },
    };
    const store = createEventStoreSync({ journal: persistence, slices: agentSlices });
    const counterStore = createStore('counter', () => {
      const count = useDurable('count', 0);
      const lastWriteTurn = useDurable('lastWriteTurn', 0);
      const write = useDurableAction<{ count: number; lastWriteTurn: number }>();
      return { count, lastWriteTurn, write };
    });
    const spec = createFeature('counter', { agent: counterStore }, { handle: counterStore })();
    const mount = () => mountAgentFeatures({ self: fakeSelf().self, store, sessionId: 'sess', agentId: 'agent-0', features: [spec] });
    const first = mount();
    await first.ready();
    await first.get(spec).write({ count: 3, lastWriteTurn: 1 });
    await first.disposeAsync();
    const restoring = Promise.withResolvers<void>();
    restoreGate = restoring.promise;
    const restored = mount();
    let ready = false;
    const readyPromise = restored.ready().then(() => { ready = true; });
    await flush();
    expect(ready).toBe(false);
    restoring.resolve();
    await readyPromise;
    const face = restored.get(spec);
    expect([face.count.value, face.lastWriteTurn.value]).toEqual([3, 1]);
    const observations: number[][] = [];
    face.subscribe((state) => { observations.push([state.count.value, state.lastWriteTurn.value]); });
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
    await expect(face.write({ count: 99 })).rejects.toThrow('disk unavailable');
    await store.reset({ ...persistence });
    face.count.value = 6;
    await flush();
    await store.flush();
    expect(face.count.value).toBe(6);
    await restored.disposeAsync();
    expect(() => face.write({ count: 7 })).toThrow('unmounted');
    const again = mount();
    await again.ready();
    expect([again.get(spec).count.value, again.get(spec).lastWriteTurn.value]).toEqual([6, 2]);
    await again.disposeAsync();
    const { shallowRef } = await import('#/kernel/index');
    const features = shallowRef([spec]);
    const changing = mountAgentFeatures({ self: fakeSelf().self, store, sessionId: 'sess', agentId: 'changing', features });
    await changing.ready();
    const replacementStore = createStore('counter', () => {
      const count = useDurable('count', 0);
      const lastWriteTurn = useDurable('lastWriteTurn', 0);
      return { count, lastWriteTurn, write: useDurableAction<{ count: number; lastWriteTurn: number }>() };
    });
    const replacement = createFeature('counter', { agent: replacementStore }, { handle: replacementStore })();
    features.value = [replacement];
    await changing.ready();
    expect(changing.get(replacement).count.value).toBe(6);
    await changing.disposeAsync();
    restoreGate = new Promise<void>(() => {});
    const cancelled = mount();
    const rejectedWrite = expect(cancelled.get(spec).write({ count: 99 })).rejects.toThrow('unregistered');
    await cancelled.disposeAsync();
    await rejectedWrite;
    restoreGate = Promise.resolve();
    const recovered = mount();
    await recovered.ready();
    expect(recovered.get(spec).count.value).toBe(6);
    await recovered.disposeAsync();
  });
});
