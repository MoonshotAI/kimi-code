import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { defineModel } from '#/wire/model';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService, PersistedRecord } from '#/wire/wireService';
import { CycleError, WireService } from '#/wire/wireServiceImpl';

const SCOPE = 'wire';
const KEY = 'store-test';

const trace: string[] = [];

const CounterModel = defineModel('store.counter', () => ({ value: 0 }));
const OtherModel = defineModel('store.other', () => ({ value: 0 }));

const counterAdd = CounterModel.defineOp('store.counter.add', {
  schema: z.object({ by: z.number() }),
  apply: (s, p) => {
    trace.push('apply.counter');
    return { value: s.value + p.by };
  },
});
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

beforeEach(() => {
  trace.length = 0;
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: KEY }]));
  log = ix.get(IAppendLogStore);
  wire = ix.get(IAgentWireService);
});

afterEach(() => disposables.dispose());

async function readRecords(
  target: IAppendLogStore = log,
  scope = SCOPE,
  key = KEY,
): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of target.read<PersistedRecord>(scope, key)) {
    out.push(record);
  }
  return out;
}

describe('WireService', () => {
  it('dispatches a single op: apply runs, record persisted, onChange fired once', async () => {
    const changes: { state: number; prev: number }[] = [];
    disposables.add(
      wire.subscribe(CounterModel, (state, prev) =>
        changes.push({ state: state.value, prev: prev.value }),
      ),
    );

    wire.dispatch(counterAdd({ by: 3 }));

    expect(wire.getModel(CounterModel)).toEqual({ value: 3 });
    expect(changes).toEqual([{ state: 3, prev: 0 }]);
    expect(await readRecords()).toEqual([
      { type: 'store.counter.add', by: 3, time: expect.any(Number) },
    ]);
  });

  it('applies a multi-op group atomically across two models before any onChange', () => {
    let otherSeenByCounter: number | undefined;
    disposables.add(
      wire.subscribe(CounterModel, () => {
        trace.push('change.counter');
        otherSeenByCounter = wire.getModel(OtherModel).value;
      }),
    );
    disposables.add(wire.subscribe(OtherModel, () => trace.push('change.other')));

    wire.dispatch(counterAdd({ by: 1 }), otherSet({ value: 42 }));

    expect(trace).toEqual([
      'apply.counter',
      'apply.other',
      'change.counter',
      'change.other',
    ]);
    expect(otherSeenByCounter).toBe(42);
    expect(wire.getModel(CounterModel)).toEqual({ value: 1 });
    expect(wire.getModel(OtherModel)).toEqual({ value: 42 });
  });

  it('replays silently: apply runs, no persist, no onChange, onRestored once', async () => {
    wire.dispatch(counterAdd({ by: 5 }));
    const records = await readRecords();

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(
      IAgentWireService,
      new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: 'replay' }]),
    );
    const log2 = ix2.get(IAppendLogStore);
    const replayed = ix2.get(IAgentWireService);

    let changes = 0;
    let restored = 0;
    disposables.add(replayed.subscribe(CounterModel, () => (changes += 1)));
    disposables.add(
      replayed.onRestored(() => {
        restored += 1;
      }),
    );

    await replayed.replay(...records);

    expect(replayed.getModel(CounterModel)).toEqual({ value: 5 });
    expect(changes).toBe(0);
    expect(restored).toBe(1);
    expect(await readRecords(log2, SCOPE, 'replay')).toEqual([]);
  });

  it('queues reentrant dispatch and drains it after the current group', () => {
    const seen: number[] = [];
    disposables.add(
      wire.subscribe(CounterModel, (state) => {
        seen.push(state.value);
        if (state.value < 3) wire.dispatch(counterAdd({ by: 1 }));
      }),
    );

    wire.dispatch(counterAdd({ by: 1 }));

    expect(wire.getModel(CounterModel)).toEqual({ value: 3 });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('throws CycleError when a dispatch cascade exceeds MAX_DRAIN', () => {
    disposables.add(wire.subscribe(CounterModel, () => wire.dispatch(otherInc({}))));
    disposables.add(wire.subscribe(OtherModel, () => wire.dispatch(counterAdd({ by: 1 }))));

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

  it('reports and counts unknown record types during replay, skipping them', async () => {
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      const result = await wire.replay(
        { type: 'store.counter.add', by: 2 },
        { type: 'no.such.op', foo: 1 },
        { type: 'store.counter.add', by: 3 },
      );

      expect(wire.getModel(CounterModel)).toEqual({ value: 5 });
      expect(result).toEqual({ unknownRecords: 1 });
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
