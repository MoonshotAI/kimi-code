/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import { BugIndicatingError } from '#/_base/errors/errors';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { Event2, event2FromRecord } from '#/app/event/event2';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { CycleError, EventDispatcherService } from '#/state/eventDispatcherService';
import { defineState } from '#/state/state';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

function stubWireJournal(journal: WireRecord[]): IWireService {
  return {
    _serviceBrand: undefined,
    seal: async () => {},
    appendRecord: (record) => {
      journal.push(record as WireRecord);
    },
    readJournal: async function* () {
      for (const record of journal) yield record;
    },
    flush: async () => {},
  };
}

interface CounterState {
  value: number;
}

class CounterAdd extends Event2<{ by: number }> {
  static override readonly type = 'state.test.counter.add';
  static override readonly durable = true;
  static override readonly schema = z.object({ by: z.number() });
}
interface CounterAdd extends z.infer<typeof CounterAdd.schema> {}

class CounterChanged extends Event2<{ value: number }> {
  static override readonly type = 'state.test.counter.changed';
  static override readonly observable = true;
}
interface CounterChanged {
  value: number;
}

class CounterSet extends Event2<{ value: number }> {
  static override readonly type = 'state.test.counter.set';
  static override readonly durable = true;
  static override readonly schema = z.object({ value: z.number() });
}
interface CounterSet extends z.infer<typeof CounterSet.schema> {}

class FailingEvent extends Event2<Record<string, never>> {
  static override readonly type = 'state.test.failing';
}

class PingEvent extends Event2<Record<string, never>> {
  static override readonly type = 'state.test.ping';
}

const counterKey = defineState('state.test.counter', () => ({ value: 0 })).replayable({
  schema: z.object({ value: z.number() }),
})
  .on(CounterAdd, (s, e, ctx) => {
    s.value += e.by;
    ctx.emit(new CounterChanged({ value: s.value }));
  })
  .on(CounterSet, (s, e) => {
    s.value = e.value;
  })
  .on(FailingEvent, (s) => {
    s.value = 999;
  });

const otherKey = defineState('state.test.other', () => ({ seen: [] as string[] })).replayable({
  schema: z.object({ seen: z.array(z.string()) }),
})
  .on(CounterAdd, (s) => {
    s.seen.push('add');
  })
  .on(FailingEvent, () => {
    throw new Error('fold failure');
  });

interface CheckpointedState {
  items: string[];
}

class ItemAdd extends Event2<{ item: string }> {
  static override readonly type = 'state.test.item.add';
  static override readonly durable = true;
  static override readonly schema = z.object({ item: z.string() });
}
interface ItemAdd extends z.infer<typeof ItemAdd.schema> {}

class AnchorEvent extends Event2<Record<string, never>> {
  static override readonly type = 'state.test.anchor';
  static override readonly durable = true;
  static override readonly schema = z.object({});
}
interface AnchorEvent extends z.infer<typeof AnchorEvent.schema> {}

class UndoEvent extends Event2<{ count: number }> {
  static override readonly type = 'state.test.undo';
  static override readonly durable = true;
  static override readonly schema = z.object({ count: z.number() });
}
interface UndoEvent extends z.infer<typeof UndoEvent.schema> {}

const checkpointedKey = defineState(
  'state.test.checkpointed',
  (): CheckpointedState => ({ items: [] }),
).replayable({ schema: z.object({ items: z.array(z.string()) }) })
  .on(ItemAdd, (s, e) => {
    s.items.push(e.item);
  })
  .on(AnchorEvent, (s, e, ctx) => {
    ctx.checkpoint();
  })
  .on(UndoEvent, (s, e, ctx) => {
    ctx.undoToCheckpoint(e.count);
  });

let disposables: DisposableStore;
let ix: TestInstantiationService;
let dispatcher: IEventDispatcher;
let agentState: IAgentStateService;
let bus: IEventBus;
let journal: WireRecord[];

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAgentBlobService, noopBlob);
  bus = ix.get(IEventBus);
  journal = [];
  ix.set(IWireService, stubWireJournal(journal));
  ix.set(IAgentStateService, new AgentStateService());
  ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
  dispatcher = ix.get(IEventDispatcher);
  agentState = ix.get(IAgentStateService);
  agentState.contributeState(counterKey);
  agentState.contributeState(otherKey);
  agentState.contributeState(checkpointedKey);
});

afterEach(() => disposables.dispose());

describe('EventDispatcherService', () => {
  it('folds a durable event into state and appends the serialized record', async () => {
    await dispatcher.dispatch(new CounterAdd({ by: 3 }));

    expect(agentState.get(counterKey)).toEqual({ value: 3 });
    expect(agentState.get(otherKey)).toEqual({ seen: ['add'] });
    expect(journal).toEqual([{ type: 'state.test.counter.add', by: 3, time: expect.any(Number) }]);
  });

  it('publishes observable events after commit; fold-emitted events follow', async () => {
    const order: string[] = [];
    disposables.add(
      bus.subscribe(CounterChanged, (event) => {
        expect(agentState.get(counterKey).value).toBe(event.value);
        order.push(`changed:${event.value}`);
      }),
    );

    await dispatcher.dispatch(new CounterAdd({ by: 5 }));

    expect(order).toEqual(['changed:5']);
  });

  it('does not publish or persist non-observable transient events', async () => {
    const seen: string[] = [];
    disposables.add(bus.subscribe((event) => seen.push(event.type)));

    await dispatcher.dispatch(new PingEvent({}));

    expect(seen).toEqual([]);
    expect(journal).toEqual([]);
  });

  it('commits all-or-nothing: a throwing fold leaves every state untouched', async () => {
    await dispatcher.dispatch(new CounterAdd({ by: 2 }));
    journal.length = 0;

    await expect(dispatcher.dispatch(new FailingEvent({}))).rejects.toThrow('fold failure');

    expect(agentState.get(counterKey).value).toBe(2);
    expect(agentState.get(otherKey).seen).toEqual(['add']);
    expect(journal).toEqual([]);
  });

  it('returns the same reference from getState when a fold is a no-op', async () => {
    const before = agentState.get(counterKey);
    await dispatcher.dispatch(new CounterSet({ value: 0 }));
    expect(agentState.get(counterKey)).toBe(before);
    expect(journal).toHaveLength(1);
  });

  it('queues reentrant dispatch from subscribers behind the current event', async () => {
    const order: string[] = [];
    let chained = false;
    disposables.add(
      bus.subscribe(CounterChanged, () => {
        order.push('changed');
        if (!chained) {
          chained = true;
          void dispatcher.dispatch(new CounterSet({ value: 100 }));
        }
      }),
    );

    await dispatcher.dispatch(new CounterAdd({ by: 1 }));

    expect(order).toEqual(['changed']);
    expect(agentState.get(counterKey).value).toBe(100);
    expect(journal.map((r) => r.type)).toEqual([
      'state.test.counter.add',
      'state.test.counter.set',
    ]);
  });

  it('rejects the failed and unexecuted reentrant dispatches without leaving promises pending', async () => {
    const queued: Promise<void>[] = [];
    disposables.add(
      bus.subscribe(CounterChanged, () => {
        queued.push(dispatcher.dispatch(new FailingEvent({})));
        queued.push(dispatcher.dispatch(new CounterSet({ value: 100 })));
      }),
    );

    await expect(dispatcher.dispatch(new CounterAdd({ by: 1 }))).rejects.toThrow('fold failure');
    const settled = await Promise.allSettled(queued);

    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
    expect(settled[1]).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
    expect(agentState.get(counterKey).value).toBe(1);
    expect(journal.map((record) => record.type)).toEqual(['state.test.counter.add']);
  });

  it('rejects only the unexecuted queued promise with CycleError past MAX_DRAIN', async () => {
    class LoopBack extends Event2<Record<string, never>> {
      static override readonly type = 'state.test.loopback';
      static override readonly observable = true;
    }
    const queued: Promise<void>[] = [];
    disposables.add(
      bus.subscribe(LoopBack, () => {
        queued.push(dispatcher.dispatch(new LoopBack({})));
      }),
    );

    await expect(dispatcher.dispatch(new LoopBack({}))).rejects.toBeInstanceOf(CycleError);
    const settled = await Promise.allSettled(queued);

    expect(settled).toHaveLength(101);
    expect(settled.slice(0, 100).every((result) => result.status === 'fulfilled')).toBe(true);
    expect(settled[100]).toMatchObject({
      status: 'rejected',
      reason: expect.any(CycleError),
    });
  });

  it('records patch history and rolls back with undo(patchId)', async () => {
    await dispatcher.dispatch(new CounterAdd({ by: 1 }));
    await dispatcher.dispatch(new CounterAdd({ by: 2 }));
    await dispatcher.dispatch(new CounterAdd({ by: 4 }));

    const history = dispatcher.history(counterKey);
    expect(history).toHaveLength(3);
    expect(history.map((entry) => entry.eventType)).toEqual([
      'state.test.counter.add',
      'state.test.counter.add',
      'state.test.counter.add',
    ]);
    expect(history[1]!.patches).toEqual([{ op: 'replace', path: ['value'], value: 3 }]);

    dispatcher.undo(counterKey, history[1]!.id);
    expect(agentState.get(counterKey).value).toBe(1);
    expect(dispatcher.history(counterKey)).toHaveLength(1);
  });

  it('drives the checkpoint protocol: checkpoint markers, depth, undoToCheckpoint', async () => {
    await dispatcher.dispatch(new ItemAdd({ item: 'a' }));
    await dispatcher.dispatch(new AnchorEvent({}));
    await dispatcher.dispatch(new ItemAdd({ item: 'b' }));
    await dispatcher.dispatch(new AnchorEvent({}));
    await dispatcher.dispatch(new ItemAdd({ item: 'c' }));

    expect(agentState.get(checkpointedKey).items).toEqual(['a', 'b', 'c']);
    expect(dispatcher.checkpointDepth(checkpointedKey)).toBe(2);

    await dispatcher.dispatch(new UndoEvent({ count: 1 }));
    expect(agentState.get(checkpointedKey).items).toEqual(['a', 'b']);
    expect(dispatcher.checkpointDepth(checkpointedKey)).toBe(1);

    await dispatcher.dispatch(new UndoEvent({ count: 1 }));
    expect(agentState.get(checkpointedKey).items).toEqual(['a']);
    expect(dispatcher.checkpointDepth(checkpointedKey)).toBe(0);

    await dispatcher.dispatch(new UndoEvent({ count: 1 }));
    expect(agentState.get(checkpointedKey).items).toEqual(['a']);
  });

  it('restores silently from the journal: folds run, nothing published or appended', async () => {
    await dispatcher.dispatch(new ItemAdd({ item: 'x' }));
    await dispatcher.dispatch(new AnchorEvent({}));
    await dispatcher.dispatch(new ItemAdd({ item: 'y' }));
    const records = [...journal];

    const seen: string[] = [];
    disposables.add(bus.subscribe((event) => seen.push(event.type)));

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.set(IAgentBlobService, noopBlob);
    const replayJournal = [...records];
    ix2.set(IWireService, stubWireJournal(replayJournal));
    ix2.set(IAgentStateService, new AgentStateService());
    ix2.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    const replayed = ix2.get(IEventDispatcher);
    const replayedState = ix2.get(IAgentStateService);
    replayedState.contributeState(checkpointedKey);

    await replayed.restore();

    expect(replayedState.get(checkpointedKey).items).toEqual(['x', 'y']);
    expect(replayed.checkpointDepth(checkpointedKey)).toBe(1);
    expect(seen).toEqual([]);
    expect(replayJournal).toEqual(records);

    await replayed.dispatch(new UndoEvent({ count: 1 }));
    expect(replayedState.get(checkpointedKey).items).toEqual(['x']);
  });

  it('skips unknown and malformed records during restore and reports them', async () => {
    const errors: unknown[] = [];
    setUnexpectedErrorHandler((error) => errors.push(error));
    try {
      const ix2 = disposables.add(new TestInstantiationService());
      ix2.set(IEventBus, new SyncDescriptor(EventBusService));
      ix2.set(IAgentBlobService, noopBlob);
      ix2.set(
        IWireService,
        stubWireJournal([
          { type: 'state.test.unknown', value: 1, time: 1 },
          { type: 'state.test.item.add', item: 42, time: 2 },
          { type: 'state.test.item.add', item: 'ok', time: 3 },
        ]),
      );
      ix2.set(IAgentStateService, new AgentStateService());
      ix2.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
      const replayed = ix2.get(IEventDispatcher);
      const replayedState = ix2.get(IAgentStateService);
      replayedState.contributeState(checkpointedKey);

      await replayed.restore();

      expect(replayedState.get(checkpointedKey).items).toEqual(['ok']);
      expect(errors).toHaveLength(2);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('serializes durable events to the flat record shape and parses them back with record time', async () => {
    const event = new CounterAdd({ by: 7 });
    expect(event.serialize()).toEqual({
      type: 'state.test.counter.add',
      by: 7,
      time: event.time,
    });

    const parsed = event2FromRecord(CounterAdd, {
      type: 'state.test.counter.add',
      by: 9,
      extra: 'stripped',
      time: 1234,
    });
    expect(parsed).toBeInstanceOf(CounterAdd);
    expect(parsed!.time).toBe(1234);
    expect((parsed as CounterAdd).by).toBe(9);
    expect(event2FromRecord(CounterAdd, { type: 'state.test.counter.add', by: 'nan' })).toBeUndefined();
  });

  it('freezes committed state against mutation', async () => {
    await dispatcher.dispatch(new CounterAdd({ by: 1 }));
    const state = agentState.get(counterKey);
    expect(Object.isFrozen(state)).toBe(true);
    expect(() => {
      (state as { value: number }).value = 5;
    }).toThrow();
  });

  it('rolls back every registry and fold index change when a late contribution fails', async () => {
    await dispatcher.restore();
    const lateKey = defineState('state.test.late', () => 0)
      .replayable({ schema: z.number() })
      .on(CounterAdd, (state, event) => state + event.by);

    expect(() => agentState.contributeState(lateKey)).toThrow(BugIndicatingError);
    expect(agentState.has(lateKey)).toBe(false);
    expect(agentState.replayableKeys()).not.toContain(lateKey);
    await expect(dispatcher.dispatch(new CounterAdd({ by: 2 }))).resolves.toBeUndefined();
    expect(agentState.get(counterKey).value).toBe(2);
  });

  it('rolls back a replayable contribution while restore is running', async () => {
    const restore = dispatcher.restore();
    const lateKey = defineState('state.test.late.mid', () => 0)
      .replayable({ schema: z.number() })
      .on(CounterAdd, (state, event) => state + event.by);

    expect(() => agentState.contributeState(lateKey)).toThrow(BugIndicatingError);
    expect(agentState.has(lateKey)).toBe(false);
    expect(agentState.replayableKeys()).not.toContain(lateKey);
    await restore;
    await expect(dispatcher.dispatch(new CounterAdd({ by: 2 }))).resolves.toBeUndefined();
  });

  it('withdraws a disposed replayable contribution from dispatcher folds and history', async () => {
    const removableKey = defineState('state.test.removable', () => 0)
      .replayable({ schema: z.number() })
      .on(CounterAdd, (state, event) => state + event.by);
    const contribution = agentState.contributeState(removableKey);
    await dispatcher.restore();

    await dispatcher.dispatch(new CounterAdd({ by: 2 }));
    expect(agentState.get(removableKey)).toBe(2);
    expect(dispatcher.history(removableKey)).toHaveLength(1);

    contribution.dispose();

    expect(agentState.has(removableKey)).toBe(false);
    expect(agentState.replayableKeys()).not.toContain(removableKey);
    expect(dispatcher.history(removableKey)).toEqual([]);
    await expect(dispatcher.dispatch(new CounterAdd({ by: 3 }))).resolves.toBeUndefined();
    expect(agentState.get(counterKey).value).toBe(5);
  });
});
