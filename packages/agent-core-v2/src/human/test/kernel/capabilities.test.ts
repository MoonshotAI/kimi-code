import { describe, expect, it } from 'vitest';

import { emit, setup, type EventFromLogic, type SnapshotFrom } from '#/xstate2';

import {
  createUnit,
  EventStoreService,
  mountRoot,
  provide,
  useDurable,
  useDurableReducer,
  useMachine,
  useNode,
  useOn,
  type DurableBackend,
  type DurableSlice,
  type Ref,
} from '#/kernel/index';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function createMemoryBackend(): {
  backend: DurableBackend;
  dispatched: Array<Record<string, unknown>>;
  reset: () => void;
} {
  const slices = new Map<string, DurableSlice>();
  const listeners = new Set<(state: unknown) => void>();
  const dispatched: Array<Record<string, unknown>> = [];
  let state: Record<string, unknown> = {};
  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener(state);
    }
  };
  const backend: DurableBackend = {
    registerSlice(slice) {
      slices.set(slice.name, slice);
      state = { ...state, [slice.name]: slice.initialState() };
      return Promise.resolve(() => {
        slices.delete(slice.name);
      });
    },
    dispatch(event) {
      dispatched.push(event);
      const store = event['store'] as string;
      const slice = slices.get(store);
      const current = state[store];
      if (slice !== undefined && typeof current === 'object' && current !== null) {
        const reducer = slice.reducers[event.type];
        if (reducer !== undefined) {
          const draft = { ...(current as Record<string, unknown>) };
          reducer(draft, event);
          state = { ...state, [store]: draft };
        }
      }
      notify();
      return Promise.resolve(undefined);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState() {
      return state;
    },
  };
  const reset = (): void => {
    for (const [name, slice] of slices) {
      state = { ...state, [name]: slice.initialState() };
    }
    notify();
  };
  return { backend, dispatched, reset };
}

function sliceState(backend: DurableBackend, name: string): Record<string, unknown> | undefined {
  return (backend.getState() as Record<string, unknown>)[name] as Record<string, unknown> | undefined;
}

describe('useDurable', () => {
  it('fails loudly without an event store backend', () => {
    const needs = createUnit('needs', () => {
      useDurable('x', 0);
    });
    expect(() => mountRoot(needs)).toThrow('useDurable requires an event store backend');
  });

  it('queues pre-registration patches, dispatches later sets, and resyncs from backend state', async () => {
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
    expect(dispatched).toHaveLength(0);
    await flush();
    expect(dispatched.map((event) => event['patch'])).toEqual([{ count: 1 }, { count: 2 }]);
    expect(sliceState(backend, 'todos')).toEqual({ count: 2 });

    if (durable !== undefined) {
      durable.value = 3;
    }
    await flush();
    expect(sliceState(backend, 'todos')).toEqual({ count: 3 });

    await backend.dispatch({ type: 'store.patched', store: 'todos', patch: { count: 42 } });
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
    reset();
    expect(durable?.value).toBe(0);
    expect(sliceState(backend, 'todos')).toEqual({ count: 0 });
  });

  it('drains patches queued while the registration drain is in flight', async () => {
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
    await backend.dispatch({ type: 'legacy.patched', store: 'todos', value: 7 });
    expect(durable?.value).toBe(7);
    expect(sliceState(backend, 'todos')).toEqual({ count: 7 });
  });
});

describe('useMachine', () => {
  it('starts the actor after setup, mirrors snapshots, and re-fires emitted events', async () => {
    const machine = setup({}).createMachine({
      id: 'probe',
      initial: 'idle',
      states: {
        idle: { on: { go: { target: 'done', actions: emit({ type: 'probe.finished' }) } } },
        done: {},
      },
    });
    const fired: string[] = [];
    let snapshot: Ref<SnapshotFrom<typeof machine> | undefined> | undefined;
    let send: ((event: EventFromLogic<typeof machine>) => void) | undefined;
    const probe = createUnit('probe', () => {
      useOn('probe.finished', () => fired.push('probe.finished'));
      const [snap, snd] = useMachine(() => machine, { key: 'probe', input: undefined });
      snapshot = snap;
      send = snd;
    });
    const { handle } = mountRoot(probe);
    expect(snapshot?.value?.value).toBe('idle');
    send?.({ type: 'go' });
    expect(snapshot?.value?.value).toBe('done');
    expect(fired).toEqual(['probe.finished']);
    await handle.unmount();
  });
});
