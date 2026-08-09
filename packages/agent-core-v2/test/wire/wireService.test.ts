import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { defineModel } from '#/wire/model';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { CycleError } from '#/wire/wireService';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from './stubs';

const SCOPE = 'wire';
const KEY = 'store-test';

const trace: string[] = [];

const CounterModel = defineModel('store.counter', () => ({ value: 0 }));
const OtherModel = defineModel('store.other', () => ({ value: 0 }));

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'wire.test.counter_changed': { readonly value: number };
    'wire.test.other_changed': { readonly value: number };
  }
}

const counterAdd = CounterModel.defineOp('store.counter.add', {
  schema: z.object({ by: z.number() }),
  apply: (s, p) => {
    trace.push('apply.counter');
    return { value: s.value + p.by };
  },
  toEvent: (_payload, state) => ({
    type: 'wire.test.counter_changed' as const,
    value: state.value,
  }),
});

declare module '#/wire/types' {
  interface PersistedOpMap {
    'store.counter.add': typeof counterAdd;
  }
}

const otherSet = OtherModel.defineOp('store.other.set', {
  schema: z.object({ value: z.number() }),
  apply: (_s, p) => {
    trace.push('apply.other');
    return { value: p.value };
  },
});
const otherInc = OtherModel.defineOp('store.other.inc', {
  schema: z.object({}),
  apply: (s) => ({ value: s.value + 1 }),
  toEvent: (_payload, state) => ({
    type: 'wire.test.other_changed' as const,
    value: state.value,
  }),
});
const mutateCounter = CounterModel.defineOp('store.counter.mutate', {
  schema: z.object({}),
  apply: (s) => {
    (s as { value: number }).value = 123;
    return s;
  },
});

let disposables: DisposableStore;
let ix: TestInstantiationService;
let wire: IWireService;
let log: IAppendLogStore;
let eventBus: IEventBus;

beforeEach(() => {
  trace.length = 0;
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  log = ix.get(IAppendLogStore);
  eventBus = ix.get(IEventBus);
  wire = registerTestAgentWire(ix, testWireScope(SCOPE, KEY), { log, eventBus });
});

afterEach(() => disposables.dispose());

async function readRecords(
  target: IAppendLogStore = log,
  scope = SCOPE,
  key = KEY,
): Promise<WireRecord[]> {
  const out: WireRecord[] = [];
  for await (const record of target.read<WireRecord>(testWireScope(scope, key), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

describe('WireService', () => {
  it('dispatches a single op into model state and the journal', async () => {
    wire.dispatch(counterAdd({ by: 3 }));

    expect(wire.getModel(CounterModel)).toEqual({ value: 3 });
    expect(await readRecords()).toEqual([
      { type: 'store.counter.add', by: 3, time: expect.any(Number) },
    ]);
  });

  it('applies a multi-op group across its models in order', () => {
    wire.dispatch(counterAdd({ by: 1 }), otherSet({ value: 42 }));

    expect(trace).toEqual(['apply.counter', 'apply.other']);
    expect(wire.getModel(CounterModel)).toEqual({ value: 1 });
    expect(wire.getModel(OtherModel)).toEqual({ value: 42 });
  });

  it('replays silently: apply runs, no event or persist, onDidRestore once', async () => {
    wire.dispatch(counterAdd({ by: 5 }));
    const records = await readRecords();

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    const log2 = ix2.get(IAppendLogStore);
    const replayEventBus = ix2.get(IEventBus);
    const replayed = registerTestAgentWire(ix2, testWireScope(SCOPE, 'replay'), {
      log: log2,
      eventBus: replayEventBus,
    });

    const events: number[] = [];
    let restored = 0;
    disposables.add(
      replayEventBus.subscribe('wire.test.counter_changed', (event) => events.push(event.value)),
    );
    disposables.add(
      replayed.hooks.onDidRestore.register('test', async (_ctx, next) => {
        restored += 1;
        await next();
      }),
    );

    await restoreTestAgentWire(
      replayed,
      log2,
      testWireScope(SCOPE, 'replay'),
      records,
    );

    expect(replayed.getModel(CounterModel)).toEqual({ value: 5 });
    expect(events).toEqual([]);
    expect(restored).toBe(1);
    expect((await readRecords(log2, SCOPE, 'replay')).slice(1)).toEqual(records);
  });

  it('fails restore when an onDidRestore hook fails', async () => {
    const expected = new Error('restore participant failed');
    disposables.add(
      wire.hooks.onDidRestore.register('failing-participant', async () => {
        throw expected;
      }),
    );

    await expect(wire.restore()).rejects.toBe(expected);
  });

  it('applies each current-version record before requesting the next record during restore', async () => {
    let streamed!: IWireService;
    const streamingLog: IAppendLogStore = {
      _serviceBrand: undefined,
      append: () => {},
      read: async function* <R>() {
        yield {
          type: 'metadata',
          protocol_version: WIRE_PROTOCOL_VERSION,
          created_at: 1,
        } as R;
        yield { type: 'store.counter.add', by: 2 } as R;
        expect(streamed.getModel(CounterModel)).toEqual({ value: 2 });
        yield { type: 'store.counter.add', by: 3 } as R;
      },
      rewrite: async () => {},
      flush: async () => {},
      close: async () => {},
      acquire: () => toDisposable(() => {}),
    };
    const streamingIx = disposables.add(new TestInstantiationService());
    streamed = registerTestAgentWire(
      streamingIx,
      testWireScope(SCOPE, 'streaming'),
      { log: streamingLog },
    );

    await streamed.restore();

    expect(streamed.getModel(CounterModel)).toEqual({ value: 5 });
  });

  it('queues reentrant dispatch and drains it after the current group', () => {
    const seen: number[] = [];
    disposables.add(
      eventBus.subscribe('wire.test.counter_changed', (event) => {
        seen.push(event.value);
        if (event.value < 3) wire.dispatch(counterAdd({ by: 1 }));
      }),
    );

    wire.dispatch(counterAdd({ by: 1 }));

    expect(wire.getModel(CounterModel)).toEqual({ value: 3 });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('throws CycleError when a dispatch cascade exceeds MAX_DRAIN', () => {
    disposables.add(
      eventBus.subscribe('wire.test.counter_changed', () => wire.dispatch(otherInc({}))),
    );
    disposables.add(
      eventBus.subscribe('wire.test.other_changed', () => wire.dispatch(counterAdd({ by: 1 }))),
    );

    expect(() => wire.dispatch(counterAdd({ by: 1 }))).toThrow(CycleError);
    try {
      wire.dispatch(counterAdd({ by: 1 }));
      expect.unreachable('dispatch should have thrown');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'wire.cycle',
        details: { depth: expect.any(Number), opTypes: expect.any(Array) },
      });
    }
  });

  it('reports unknown record types during replay and skips them', async () => {
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await restoreTestAgentWire(
        wire,
        log,
        testWireScope(SCOPE, KEY),
        [
          { type: 'store.counter.add', by: 2 },
          { type: 'no.such.op', foo: 1 },
          { type: 'store.counter.add', by: 3 },
        ],
      );

      expect(wire.getModel(CounterModel)).toEqual({ value: 5 });
      expect(unexpected).toHaveLength(1);
      expect(unexpected[0]).toMatchObject({
        code: 'wire.unknown_record',
        details: { type: 'no.such.op', index: 1 },
      });
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('freezes state: getModel is frozen and mutation throws in strict mode', () => {
    wire.dispatch(counterAdd({ by: 2 }));
    const state = wire.getModel(CounterModel);

    expect(Object.isFrozen(state)).toBe(true);
    expect(() => {
      (state as { value: number }).value = 99;
    }).toThrow(TypeError);
    expect(wire.getModel(CounterModel)).toEqual({ value: 2 });
  });

  it('throws when an apply mutates its already-frozen incoming state', () => {
    wire.dispatch(counterAdd({ by: 1 }));

    expect(() => wire.dispatch(mutateCounter({}))).toThrow(TypeError);
    expect(wire.getModel(CounterModel)).toEqual({ value: 1 });
  });
});
