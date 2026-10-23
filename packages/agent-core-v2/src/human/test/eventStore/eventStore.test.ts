import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { storeActor } from '#/eventStore/actor';
import { createEventStore, type Cause } from '#/eventStore/eventStore';
import { defineEvent } from '#/eventStore/events';
import { journalFromBranch } from '#/eventStore/journal';
import { createSlice } from '#/eventStore/slice';
import { MemoryBackend } from '#/store/backend/memory';
import { TreeStore } from '#/store/store';
import type { Tree } from '#/store/tree';
import { createActor, waitFor } from '#/xstate2';

const counterAdded = defineEvent({ type: 'test.counter_added', schema: z.object({ amount: z.number() }) });
type CounterAdded = ReturnType<typeof counterAdded>;

const noteTagged = defineEvent({ type: 'test.note_tagged', schema: z.object({ tag: z.string() }) });
type NoteTagged = ReturnType<typeof noteTagged>;

const counterSlice = createSlice({
  name: 'counter',
  initialState: () => 0,
  reducers: {
    'test.counter_added': (draft, event: CounterAdded) => draft + event.amount,
    'test.counter_bumped_internal': (draft) => draft + 100,
  },
});

const notesSlice = createSlice({
  name: 'notes',
  initialState: () => [] as string[],
  reducers: {
    'test.note_tagged': (draft, event: NoteTagged) => {
      draft.push(event.tag);
    },
  },
});

const slices = { counter: counterSlice, notes: notesSlice };

async function openTree(backend: MemoryBackend = new MemoryBackend()): Promise<Tree> {
  const store = await TreeStore.open(backend, {});
  return store.tree('test');
}

async function openJournal(tree: Tree, branch = 'main') {
  if (!tree.has(branch)) tree.createBranch(branch);
  return journalFromBranch(tree.openBranch(branch), tree);
}

async function openStore(tree: Tree, opts?: { drainLimit?: number; extraSlices?: Record<string, never> }) {
  const journal = await openJournal(tree);
  return createEventStore({ journal, slices, drainLimit: opts?.drainLimit });
}

describe('createEventStore', () => {
  it('folds dispatched events and refolds them on reopen', async () => {
    const tree = await openTree();
    const store = await openStore(tree);
    await store.dispatch(counterAdded({ amount: 3 }));
    await store.dispatch(noteTagged({ tag: 'a' }));
    await store.flush();

    expect(store.getState()).toEqual({ counter: 3, notes: ['a'] });

    const reopened = await openStore(tree);
    expect(reopened.getState()).toEqual({ counter: 3, notes: ['a'] });
  });

  it('freezes refolded slice state on reopen', async () => {
    const tree = await openTree();
    const store = await openStore(tree);
    await store.dispatch(noteTagged({ tag: 'a' }));
    await store.dispatch(noteTagged({ tag: 'b' }));
    await store.flush();

    const reopened = await openStore(tree);
    const notes = reopened.slice('notes');
    expect(notes).toEqual(['a', 'b']);
    expect(Object.isFrozen(notes)).toBe(true);
  });

  it('matches immutable replay and preserves subsequent live update semantics', async () => {
    const tree = await openTree();
    const raiserSlice = createSlice({
      name: 'raiser',
      initialState: () => 0,
      reducers: {
        'test.counter_added': (draft, event: CounterAdded, ctx) => {
          ctx.enqueue.raise({ type: 'test.counter_bumped_internal' });
          return draft + event.amount;
        },
      },
    });
    const liveSlices = { counter: counterSlice, notes: notesSlice, raiser: raiserSlice };
    const journal = await openJournal(tree);
    const live = await createEventStore({ journal, slices: liveSlices });
    await live.dispatch(counterAdded({ amount: 5 }));
    await live.dispatch(noteTagged({ tag: 'a' }));
    await live.flush();

    const expected = await createEventStore({ journal, slices: liveSlices });
    const actual = await createEventStore({ journal, slices: liveSlices, mutableReplay: true });
    expect(actual.getState()).toEqual(expected.getState());
    expect(Object.isFrozen(actual.slice('notes'))).toBe(true);

    const restored = actual.getState();
    await actual.dispatch(noteTagged({ tag: 'b' }));
    await actual.dispatch(counterAdded({ amount: 1 }));
    expect(actual.getState()).toEqual({ counter: 206, notes: ['a', 'b'], raiser: 6 });
    expect(restored).toEqual({ counter: 105, notes: ['a'], raiser: 5 });

    await actual.reset(journal);
    expect(actual.getState()).toEqual({ counter: 206, notes: ['a', 'b'], raiser: 6 });
    expect(Object.isFrozen(actual.slice('notes'))).toBe(true);
  });

  it('restores the previous state and journal when mutable replay fails', async () => {
    const failingSlice = createSlice({
      name: 'failing',
      initialState: () => 0,
      reducers: {
        'test.note_tagged': () => {
          throw new Error('fold failure');
        },
      },
    });
    const goodJournal = await openJournal(await openTree());
    const store = await createEventStore({
      journal: goodJournal,
      slices: { counter: counterSlice, notes: notesSlice, failing: failingSlice },
      mutableReplay: true,
    });
    const before = store.getState();
    const beforeRef = store.ref;
    const badJournal = await openJournal(await openTree());
    await badJournal.append({
      type: 'test.note_tagged',
      kind: 'event',
      data: { type: 'test.note_tagged', time: 1, tag: 'bad' },
    });

    await expect(store.reset(badJournal)).rejects.toThrow('fold failure');
    expect(store.getState()).toBe(before);
    expect(store.ref).toEqual(beforeRef);

    await store.dispatch(counterAdded({ amount: 1 }));
    const records = [];
    for await (const record of goodJournal.read()) records.push(record);
    expect(records.at(-1)?.type).toBe('test.counter_added');
  });

  it('rolls back a failed slice registration and allows a retry', async () => {
    let shouldFail = true;
    const flakySlice = createSlice({
      name: 'flaky',
      initialState: () => [] as string[],
      reducers: {
        'test.note_tagged': (draft, event: NoteTagged) => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error('fold failure');
          }
          draft.push(event.tag);
        },
      },
    });
    const journal = await openJournal(await openTree());
    await journal.append({
      type: 'test.note_tagged',
      kind: 'event',
      data: { type: 'test.note_tagged', time: 1, tag: 'a' },
    });
    const store = await createEventStore({ journal, slices: { notes: notesSlice }, mutableReplay: true });

    await expect(store.registerSlice(flakySlice)).rejects.toThrow('fold failure');
    expect(store.getState()).toEqual({ notes: ['a'] });

    await store.registerSlice(flakySlice);
    expect(store.getState()).toEqual({ notes: ['a'], flaky: ['a'] });
  });

  it('ignores legacy snapshot entries when folding', async () => {
    const tree = await openTree();
    const journal = await openJournal(tree);
    await journal.append({ type: 'snapshot', kind: 'snapshot', data: { slices: { counter: 41 } } });
    await journal.append({
      type: 'test.counter_added',
      kind: 'event',
      data: { type: 'test.counter_added', time: 1, amount: 1 },
    });
    const store = await createEventStore({ journal, slices });
    expect(store.getState()).toEqual({ counter: 1, notes: [] });
  });

  it('skips unknown event types when folding', async () => {
    const tree = await openTree();
    const journal = await openJournal(tree);
    await journal.append({ type: 'test.unknown_event', kind: 'event', data: { type: 'test.unknown_event' } });
    await journal.append({
      type: 'test.counter_added',
      kind: 'event',
      data: { type: 'test.counter_added', time: 1, amount: 5 },
    });
    const store = await createEventStore({ journal, slices });
    expect(store.slice('counter')).toBe(5);
  });
});

describe('dispatch', () => {
  it('rejects unregistered events and schema-invalid events', async () => {
    const tree = await openTree();
    const store = await openStore(tree);
    await expect(
      store.dispatch({ type: 'test.ghost_event', time: 1, amount: 1 }),
    ).rejects.toMatchObject({
      code: 'unregistered-event',
    });
    await expect(store.dispatch(counterAdded({ amount: 'x' as unknown as number }))).rejects.toMatchObject({
      code: 'schema',
    });
    expect(store.slice('counter')).toBe(0);
  });

  it('serializes concurrent dispatches in seq order', async () => {
    const tree = await openTree();
    const store = await openStore(tree);
    const [a, b] = await Promise.all([
      store.dispatch(counterAdded({ amount: 1 })),
      store.dispatch(counterAdded({ amount: 2 })),
    ]);
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(store.slice('counter')).toBe(3);
  });

  it('reads back appended entries through the journal', async () => {
    const tree = await openTree();
    const store = await openStore(tree);
    await store.dispatch(noteTagged({ tag: 'x' }));
    await store.flush();
    const records = [];
    for await (const record of (await openJournal(tree)).read()) records.push(record);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ branch: 'main', seq: 0, type: 'test.note_tagged', kind: 'event' });
  });
});

describe('internal events', () => {
  it('folds raised internal events across slices without persisting them', async () => {
    const tree = await openTree();
    const raiserSlice = createSlice({
      name: 'raiser',
      initialState: () => 0,
      reducers: {
        'test.counter_added': (draft, event: CounterAdded, ctx) => {
          ctx.enqueue.raise({ type: 'test.counter_bumped_internal' });
          return draft + event.amount;
        },
      },
    });
    const journal = await openJournal(tree);
    const store = await createEventStore({ journal, slices: { counter: counterSlice, raiser: raiserSlice } });
    await store.dispatch(counterAdded({ amount: 5 }));
    expect(store.getState()).toEqual({ counter: 105, raiser: 5 });

    const records = [];
    for await (const record of journal.read()) records.push(record);
    expect(records).toHaveLength(1);

    const reopened = await createEventStore({ journal, slices: { counter: counterSlice, raiser: raiserSlice } });
    expect(reopened.getState()).toEqual({ counter: 105, raiser: 5 });
  });

  it('enforces the drain limit', async () => {
    const tree = await openTree();
    const loopSlice = createSlice({
      name: 'loop',
      initialState: () => 0,
      reducers: {
        'test.counter_added': (draft, _event, ctx) => {
          ctx.enqueue.raise({ type: 'test.counter_bumped_internal' });
          return draft + 1;
        },
        'test.counter_bumped_internal': (draft, _event, ctx) => {
          ctx.enqueue.raise({ type: 'test.counter_bumped_internal' });
          return draft + 1;
        },
      },
    });
    const journal = await openJournal(tree);
    const store = await createEventStore({ journal, slices: { loop: loopSlice }, drainLimit: 10 });
    await expect(store.dispatch(counterAdded({ amount: 1 }))).rejects.toMatchObject({
      code: 'drain-limit',
    });
  });
});

describe('registerSlice', () => {
  it('folds history for late-joined slices and notifies slice-joined', async () => {
    const tree = await openTree();
    const journal = await openJournal(tree);
    const store = await createEventStore({ journal, slices: { counter: counterSlice } });
    await store.dispatch(counterAdded({ amount: 7 }));
    await store.dispatch(noteTagged({ tag: 'late' }));

    const causes: Cause<any>[] = [];
    store.subscribe((_state, cause) => causes.push(cause));
    await store.registerSlice(notesSlice);
    expect(store.getState()).toEqual({ counter: 7, notes: ['late'] });
    expect(causes).toEqual([{ kind: 'slice-joined', name: 'notes' }]);
  });
});

describe('reset', () => {
  it('refolds a forked branch and keeps subscribers attached', async () => {
    const tree = await openTree();
    const store = await openStore(tree);
    await store.dispatch(counterAdded({ amount: 1 }));
    await store.dispatch(counterAdded({ amount: 2 }));
    await store.dispatch(counterAdded({ amount: 4 }));
    await store.flush();

    const forked = tree.createBranch('forked', { from: { branch: 'main', seq: 1 } });
    const causes: Cause<any>[] = [];
    store.subscribe((_state, cause) => causes.push(cause));
    await store.reset(journalFromBranch(forked, tree));

    expect(store.ref.branch).toBe('forked');
    expect(store.slice('counter')).toBe(3);
    expect(causes).toEqual([{ kind: 'reset', state: { counter: 3, notes: [] } }]);

    await store.dispatch(counterAdded({ amount: 8 }));
    expect(store.slice('counter')).toBe(11);

    const reopened = await createEventStore({ journal: journalFromBranch(forked, tree), slices });
    expect(reopened.slice('counter')).toBe(11);
  });
});

describe('storeActor', () => {
  function once<T>(actor: ReturnType<typeof createActor>, type: string): Promise<T> {
    return new Promise<T>((resolve) => {
      const sub = actor.on(type, (event) => {
        sub.unsubscribe();
        resolve(event as T);
      });
    });
  }

  it('emits store.ready on start and store.changed after store.append', async () => {
    const tree = await openTree();
    const store = await openStore(tree);
    const actor = createActor(storeActor, { input: { store } });
    const ready = once<{ type: string }>(actor, 'store.ready');
    const changed = once<{ type: string }>(actor, 'store.changed');
    actor.start();
    actor.send({ type: 'store.append', event: counterAdded({ amount: 2 }) });
    expect((await ready).type).toBe('store.ready');
    expect((await changed).type).toBe('store.changed');
    expect(store.slice('counter')).toBe(2);
    actor.stop();
  });

  it('emits store.reset after store.switch to a forked journal', async () => {
    const tree = await openTree();
    const store = await openStore(tree);
    await store.dispatch(counterAdded({ amount: 1 }));
    await store.dispatch(counterAdded({ amount: 2 }));
    await store.flush();

    const actor = createActor(storeActor, { input: { store } });
    const reset = once<{ type: string; branch: string }>(actor, 'store.reset');
    actor.start();
    const forked = tree.createBranch('forked', { from: { branch: 'main', seq: 0 } });
    actor.send({ type: 'store.switch', journal: journalFromBranch(forked, tree) });
    expect(await reset).toMatchObject({ type: 'store.reset', branch: 'forked' });
    expect(store.slice('counter')).toBe(1);
    actor.stop();
  });

  it('emits store.error when a dispatch fails', async () => {
    const tree = await openTree();
    const store = await openStore(tree);
    const actor = createActor(storeActor, { input: { store } });
    const failure = once<{ type: string }>(actor, 'store.error');
    actor.start();
    actor.send({
      type: 'store.append',
      event: { type: 'test.unregistered_event', time: Date.now() },
    });
    expect((await failure).type).toBe('store.error');
    actor.stop();
  });
});
