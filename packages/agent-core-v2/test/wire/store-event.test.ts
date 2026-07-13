import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { defineModel } from '#/wire/model';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService, PersistedRecord } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'store-event.added': { value: number };
    'store-event.otherSet': { value: number };
  }
}

const SCOPE = 'wire';
const KEY = 'store-event-test';

const CounterModel = defineModel('store-event.counter', () => ({ value: 0 }));
const OtherModel = defineModel('store-event.other', () => ({ value: 0 }));

const addWithEvent = CounterModel.defineOp('store-event.counter.add', {
  schema: z.object({ by: z.number() }),
  apply: (s, p) => ({ value: s.value + p.by }),
  toEvent: (_p, state) => ({ type: 'store-event.added' as const, value: state.value }),
});
const addNoEvent = CounterModel.defineOp('store-event.counter.addNoEvent', {
  schema: z.object({ by: z.number() }),
  apply: (s, p) => ({ value: s.value + p.by }),
});
const addUndefinedEvent = CounterModel.defineOp('store-event.counter.addUndef', {
  schema: z.object({ by: z.number() }),
  apply: (s, p) => ({ value: s.value + p.by }),
  toEvent: () => undefined,
});
const otherSet = OtherModel.defineOp('store-event.other.set', {
  schema: z.object({ value: z.number() }),
  apply: (_s, p) => ({ value: p.value }),
  toEvent: (p) => ({ type: 'store-event.otherSet' as const, value: p.value }),
});

let disposables: DisposableStore;
let wire: IWireService;
let eventBus: IEventBus;
let log: IAppendLogStore;

function setup(logKey: string): {
  ix: TestInstantiationService;
  wire: IWireService;
  eventBus: IEventBus;
  log: IAppendLogStore;
} {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey }]));
  return {
    ix,
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
    wire: ix.get(IAgentWireService),
  };
}

beforeEach(() => {
  disposables = new DisposableStore();
  ({ wire, eventBus, log } = setup(KEY));
});

afterEach(() => disposables.dispose());

async function readRecords(
  target: IAppendLogStore = log,
  key = KEY,
): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of target.read<PersistedRecord>(SCOPE, key)) {
    out.push(record);
  }
  return out;
}

describe('WireService Op.toEvent', () => {
  it('publishes the derived event after apply, reading post-apply state', () => {
    const seen: DomainEvent[] = [];
    disposables.add(eventBus.subscribe((e) => seen.push(e)));

    wire.dispatch(addWithEvent({ by: 3 }));

    expect(wire.getModel(CounterModel)).toEqual({ value: 3 });
    expect(seen).toEqual([{ type: 'store-event.added', value: 3 }]);
  });

  it('publishes nothing for an op without toEvent', () => {
    const seen: DomainEvent[] = [];
    disposables.add(eventBus.subscribe((e) => seen.push(e)));

    wire.dispatch(addNoEvent({ by: 5 }));

    expect(wire.getModel(CounterModel)).toEqual({ value: 5 });
    expect(seen).toEqual([]);
  });

  it('publishes nothing when toEvent returns undefined', () => {
    const seen: DomainEvent[] = [];
    disposables.add(eventBus.subscribe((e) => seen.push(e)));

    wire.dispatch(addUndefinedEvent({ by: 7 }));

    expect(wire.getModel(CounterModel)).toEqual({ value: 7 });
    expect(seen).toEqual([]);
  });

  it('does not publish during replay (silent)', async () => {
    wire.dispatch(addWithEvent({ by: 4 }));
    const records = await readRecords();

    const replay = setup('replay');
    const seen: DomainEvent[] = [];
    disposables.add(replay.eventBus.subscribe((e) => seen.push(e)));

    await replay.wire.replay(...records);

    expect(replay.wire.getModel(CounterModel)).toEqual({ value: 4 });
    expect(seen).toEqual([]);
  });

  it('publishes one event per op, in op order, for an atomic multi-op dispatch', () => {
    const seen: DomainEvent[] = [];
    disposables.add(eventBus.subscribe((e) => seen.push(e)));

    wire.dispatch(addWithEvent({ by: 1 }), otherSet({ value: 42 }));

    expect(seen).toEqual([
      { type: 'store-event.added', value: 1 },
      { type: 'store-event.otherSet', value: 42 },
    ]);
  });
});
