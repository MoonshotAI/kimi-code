import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import { createUnit, mountRoot, provide, useNode, type Ref } from '#/kernel/index';
import { EventStoreService, useDurable, useDurableReducer, type DurableStore } from '#/store/index';
import { createEventStoreSync, memoryJournal, defineEvent } from '#/store/log';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const legacyPatched = defineEvent({ type: 'legacy.patched', schema: z.object({ store: z.string(), value: z.number() }) });

function createMemoryBackend() {
  const backend = createEventStoreSync({ journal: memoryJournal(), slices: {} });
  const dispatched: Array<Record<string, unknown>> = [];
  const dispatch = backend.dispatch.bind(backend);
  backend.dispatch = (event) => {
    dispatched.push(...(Array.isArray(event) ? event : [event]));
    return dispatch(event);
  };
  return { backend, dispatched, reset: () => backend.reset(memoryJournal()) };
}

function sliceState(backend: DurableStore, name: string): Record<string, unknown> | undefined {
  return (backend.getState() as Record<string, unknown>)[name] as Record<string, unknown> | undefined;
}

describe('useDurable', () => {
  it('fails loudly without an event store backend', () => {
    const needs = createUnit('needs', () => {
      useDurable('x', 0);
    });
    expect(() => mountRoot(needs)).toThrow('useDurable requires an event store backend');
  });

  it('dispatches sets immediately and resyncs from backend state', async () => {
    const { backend, dispatched } = createMemoryBackend();
    let durable: Ref<number> | undefined;
    const todos = createUnit('todos', () => {
      durable = useDurable('count', 0);
      durable.value = 1;
      durable.value = 2;
    });
    const root = createUnit('root', () => {
      provide(EventStoreService, backend);
      useNode().mount(todos);
    });
    mountRoot(root);
    expect(durable?.value).toBe(2);
    await flush();
    expect(dispatched.map((event) => event['patch'])).toEqual([{ count: 1 }, { count: 2 }]);
    expect(sliceState(backend, 'todos')).toEqual({ count: 2 });

    if (durable !== undefined) {
      durable.value = 3;
    }
    await flush();
    expect(sliceState(backend, 'todos')).toEqual({ count: 3 });

    await backend.dispatch({ type: 'store.patched', time: Date.now(), store: 'todos', patch: { count: 42 } });
    expect(durable?.value).toBe(42);

    const before = dispatched.length;
    if (durable !== undefined) {
      durable.value = 42;
    }
    await flush();
    expect(dispatched).toHaveLength(before);
  });
});

describe('useDurableReducer', () => {
  it('throws when a reducer registers after the first useDurable', () => {
    const { backend } = createMemoryBackend();
    const late = createUnit('late', () => {
      useDurable('x', 0);
      useDurableReducer('late.event', () => {});
    });
    const { node } = mountRoot(
      createUnit('root', () => {
        provide(EventStoreService, backend);
      }),
    );
    expect(() => node.mount(late)).toThrow(
      "useDurableReducer for event 'late.event' must run before the first useDurable in unit 'late'",
    );
  });

  it('rewinds to static initial state on backend reset instead of live values', async () => {
    const { backend, reset } = createMemoryBackend();
    let durable: Ref<number> | undefined;
    const todos = createUnit('todos', () => {
      durable = useDurable('count', 0);
      durable.value = 5;
    });
    const root = createUnit('root', () => {
      provide(EventStoreService, backend);
      useNode().mount(todos);
    });
    mountRoot(root);
    await flush();
    expect(sliceState(backend, 'todos')).toEqual({ count: 5 });
    await reset();
    expect(durable?.value).toBe(0);
    expect(sliceState(backend, 'todos')).toEqual({ count: 0 });
  });

  it('dispatches nested sets issued while a dispatch is in flight', async () => {
    const { backend, dispatched } = createMemoryBackend();
    let durable: Ref<number> | undefined;
    let nested = false;
    const inner = backend.dispatch;
    backend.dispatch = (event) => {
      const result = inner(event);
      const patch = event['patch'] as Record<string, unknown> | undefined;
      if (!nested && patch?.['count'] === 1 && durable !== undefined) {
        nested = true;
        durable.value = 2;
      }
      return result;
    };
    const todos = createUnit('todos', () => {
      durable = useDurable('count', 0);
      durable.value = 1;
    });
    const root = createUnit('root', () => {
      provide(EventStoreService, backend);
      useNode().mount(todos);
    });
    mountRoot(root);
    await flush();
    expect(dispatched.map((event) => event['patch'])).toEqual([{ count: 1 }, { count: 2 }]);
    expect(sliceState(backend, 'todos')).toEqual({ count: 2 });
    expect(durable?.value).toBe(2);
  });

  it('folds pre-existing record events into slice state', async () => {
    const { backend } = createMemoryBackend();
    let durable: Ref<number> | undefined;
    const todos = createUnit('todos', () => {
      useDurableReducer(
        'legacy.patched',
        (draft: Record<string, unknown>, event: { value?: unknown }) => {
          draft['count'] = event.value;
        },
      );
      durable = useDurable('count', 0);
    });
    const root = createUnit('root', () => {
      provide(EventStoreService, backend);
      useNode().mount(todos);
    });
    mountRoot(root);
    await flush();
    expect(durable?.value).toBe(0);
    await backend.dispatch(legacyPatched({ store: 'todos', value: 7 }));
    expect(durable?.value).toBe(7);
    expect(sliceState(backend, 'todos')).toEqual({ count: 7 });
  });
});


