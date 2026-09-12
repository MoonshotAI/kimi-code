/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import { BugIndicatingError } from '#/_base/errors/errors';
import { AgentSpaceImpl } from '#/agent/agentContext/agentSpace';
import '#/agent/contextMemory/conversationTime';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
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
    append: (record) => {
      journal.push(record as WireRecord);
    },
    readJournal: async function* () {
      for (const record of journal) yield record;
    },
    readRestorable: async function* () {
      for (const record of journal) yield record;
    },
    readHumanChain: () => [],
    read: async function* () {
      for (const record of journal) yield record;
    },
    readRaw: async function* () {
      for (const record of journal) yield record;
    },
    journalRef: { tree: 'stub', branch: 'main' },
    switchBranch: async () => {
      throw new Error('stubWireJournal.switchBranch is not implemented');
    },
    branches: () => ['main'],
    nextSeq: () => journal.length + 1,
    settled: async () => {},
    flush: async () => {}, drainPersisted: async () => {},
    lineCount: () => journal.length,
    lastContextClearLine: () => undefined,
    journalPath: () => undefined,
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

class ClearEvent extends Event2<Record<string, never>> {
  static override readonly type = 'state.test.clear';
  static override readonly durable = true;
  static override readonly schema = z.object({});
}
interface ClearEvent extends z.infer<typeof ClearEvent.schema> {}

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
  })
  .on(ClearEvent, (s, e, ctx) => {
    ctx.clearCheckpoints();
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

  it('rolls back to replay-time snapshot checkpoints on unpaired undo records and gates live undo', async () => {
    await dispatcher.dispatch(new ItemAdd({ item: 'a' }));
    await dispatcher.dispatch(new AnchorEvent({}));
    await dispatcher.dispatch(new ItemAdd({ item: 'b' }));
    await dispatcher.dispatch(new AnchorEvent({}));
    await dispatcher.dispatch(new ItemAdd({ item: 'c' }));
    expect(agentState.get(checkpointedKey).items).toEqual(['a', 'b', 'c']);

    await dispatcher.dispatch(new UndoEvent({ count: 1 }));
    expect(agentState.get(checkpointedKey).items).toEqual(['a', 'b', 'c']);

    journal.push(new UndoEvent({ count: 1 }).serialize());
    journal.push(new UndoEvent({ count: 1 }).serialize());

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.set(IAgentBlobService, noopBlob);
    ix2.set(IWireService, stubWireJournal([...journal]));
    ix2.set(IAgentStateService, new AgentStateService());
    ix2.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    const replayed = ix2.get(IEventDispatcher);
    const replayedState = ix2.get(IAgentStateService);
    replayedState.contributeState(checkpointedKey);

    await replayed.restore();

    expect(replayedState.get(checkpointedKey).items).toEqual(['a']);
  });

  it('bounds replay-time checkpoint stacks at clear records and ignores undos beyond the stack', async () => {
    journal.push(
      new ItemAdd({ item: 'a' }).serialize(),
      new AnchorEvent({}).serialize(),
      new ClearEvent({}).serialize(),
      new ItemAdd({ item: 'b' }).serialize(),
      new AnchorEvent({}).serialize(),
      new ItemAdd({ item: 'c' }).serialize(),
      new UndoEvent({ count: 1 }).serialize(),
      new UndoEvent({ count: 1 }).serialize(),
    );

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.set(IAgentBlobService, noopBlob);
    ix2.set(IWireService, stubWireJournal([...journal]));
    ix2.set(IAgentStateService, new AgentStateService());
    ix2.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    const replayed = ix2.get(IEventDispatcher);
    const replayedState = ix2.get(IAgentStateService);
    replayedState.contributeState(checkpointedKey);

    await replayed.restore();

    expect(replayedState.get(checkpointedKey).items).toEqual(['a', 'b']);
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
    expect(seen).toEqual([]);
    expect(replayJournal).toEqual(records);
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
          { type: 'staleGuard.recorded', path: '/tmp/a.txt', mtimeMs: 111, time: 1 },
          { type: 'staleGuard.cleared', time: 1 },
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

  it('rejects a duplicate durable participant id without replacing the first attachment', () => {
    const participant = {
      id: 'runtime.test.duplicate',
      events: [],
      undoable: false,
      transition: () => {},
      getState: () => 0,
      commit: () => {},
    };
    const attachment = dispatcher.attach(participant);

    expect(() => dispatcher.attach({ ...participant })).toThrow(
      "Durable participant 'runtime.test.duplicate' is already attached",
    );
    attachment.dispose();
    expect(() => dispatcher.attach({ ...participant })).not.toThrow();
  });

  it('runs runtime attachments through the shared replay checkpoint pipeline', async () => {
    journal.push(
      new ItemAdd({ item: 'a' }).serialize(),
      new AnchorEvent({}).serialize(),
      new ItemAdd({ item: 'b' }).serialize(),
      new AnchorEvent({}).serialize(),
      new ItemAdd({ item: 'c' }).serialize(),
      new UndoEvent({ count: 2 }).serialize(),
    );
    let state: CheckpointedState = { items: [] };
    dispatcher.attach({
      id: 'runtime.test.checkpointed',
      events: [ItemAdd, AnchorEvent, UndoEvent],
      undoable: true,
      transition: (draft, event, ctx) => {
        if (event instanceof ItemAdd) draft.items.push(event.item);
        if (event instanceof AnchorEvent) ctx.checkpoint();
        if (event instanceof UndoEvent) ctx.undoToCheckpoint(event.count);
      },
      getState: () => state,
      commit: (next) => { state = next; },
    });

    await dispatcher.restore();

    expect(state.items).toEqual(['a']);

    await dispatcher.dispatch(new UndoEvent({ count: 1 }));
    expect(state.items).toEqual(['a']);
  });

  it('replays journal history into a late-attached participant and folds live events after', async () => {
    await dispatcher.dispatch(new ItemAdd({ item: 'a' }));
    await dispatcher.dispatch(new AnchorEvent({}));
    await dispatcher.dispatch(new ItemAdd({ item: 'b' }));
    await dispatcher.restore();

    let state: CheckpointedState = { items: [] };
    await dispatcher.attachLate({
      id: 'runtime.test.late',
      events: [ItemAdd, AnchorEvent, UndoEvent],
      undoable: true,
      transition: (draft, event, ctx) => {
        if (event instanceof ItemAdd) draft.items.push(event.item);
        if (event instanceof AnchorEvent) ctx.checkpoint();
        if (event instanceof UndoEvent) ctx.undoToCheckpoint(event.count);
      },
      getState: () => state,
      commit: (next) => { state = next; },
    });

    expect(state.items).toEqual(['a', 'b']);

    await dispatcher.dispatch(new ItemAdd({ item: 'c' }));
    expect(state.items).toEqual(['a', 'b', 'c']);

    await dispatcher.dispatch(new UndoEvent({ count: 1 }));
    expect(state.items).toEqual(['a', 'b', 'c']);
  });

  it('queues live dispatch during a late attach and drains it after the catch-up', async () => {
    await dispatcher.dispatch(new ItemAdd({ item: 'history' }));
    await dispatcher.restore();

    let state: CheckpointedState = { items: [] };
    const participant = {
      id: 'runtime.test.late-gated',
      events: [ItemAdd] as const,
      undoable: false,
      transition: (draft: CheckpointedState, event: unknown) => {
        if (event instanceof ItemAdd) draft.items.push(event.item);
      },
      getState: () => state,
      commit: (next: CheckpointedState) => { state = next; },
    };
    const late = dispatcher.attachLate(participant);
    const live = dispatcher.dispatch(new ItemAdd({ item: 'live' }));
    await late;
    await live;

    expect(state.items).toEqual(['history', 'live']);
  });

  it('rejects late attach before restore, attaches after restore, and rejects a pending late attach on dispose', async () => {
    const participant = {
      id: 'runtime.test.late-phase',
      events: [] as const,
      undoable: false,
      transition: () => {},
      getState: () => 0,
      commit: () => {},
    };

    await expect(dispatcher.attachLate({ ...participant })).rejects.toThrow(
      /late-attached while the event dispatcher is in phase 'new'/,
    );

    await dispatcher.restore();

    expect(() => dispatcher.attach({ ...participant })).toThrow(
      /must attach before restore/,
    );
    await expect(dispatcher.attachLate({ ...participant })).resolves.toBeDefined();

    const wire = ix.get(IWireService);
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    wire.readRestorable = async function* () {
      await gate;
      yield* [];
    };
    wire.readJournal = async function* () {
      await gate;
      yield* [];
    };
    const rerun = dispatcher.restore();
    const pending = dispatcher.attachLate({ ...participant, id: 'runtime.test.late-dispose' });
    (dispatcher as EventDispatcherService).dispose();

    await expect(pending).rejects.toThrow(/disposed while a late attach was pending/);

    releaseRead();
    await rerun;
  });

  it('does not own AgentSpace teardown', () => {
    const isolated = new TestInstantiationService();
    const scope = makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' });
    const space = scope.agentContext.space as AgentSpaceImpl;
    const kill = vi.spyOn(space, '_kill');
    isolated.set(IEventBus, new SyncDescriptor(EventBusService));
    isolated.set(IAgentBlobService, noopBlob);
    isolated.set(IWireService, stubWireJournal([]));
    isolated.set(IAgentScopeContext, scope);
    isolated.set(IAgentStateService, new AgentStateService());
    isolated.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    isolated.get(IEventDispatcher);

    isolated.dispose();

    expect(kill).not.toHaveBeenCalled();
  });

  it('withdraws a disposed replayable contribution from dispatcher folds', async () => {
    const removableKey = defineState('state.test.removable', () => 0)
      .replayable({ schema: z.number() })
      .on(CounterAdd, (state, event) => state + event.by);
    const contribution = agentState.contributeState(removableKey);
    await dispatcher.restore();

    await dispatcher.dispatch(new CounterAdd({ by: 2 }));
    expect(agentState.get(removableKey)).toBe(2);

    contribution.dispose();

    expect(agentState.has(removableKey)).toBe(false);
    expect(agentState.replayableKeys()).not.toContain(removableKey);
    await expect(dispatcher.dispatch(new CounterAdd({ by: 3 }))).resolves.toBeUndefined();
    expect(agentState.get(counterKey).value).toBe(5);
  });
});
