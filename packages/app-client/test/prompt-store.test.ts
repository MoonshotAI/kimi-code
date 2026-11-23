import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppMessage, AppQueuedInput } from '@moonshot-ai/app-core/api';
import { sessionsStore } from '../src/stores/sessions';
import { movedQueue, promptStore } from '../src/stores/prompt';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

function bubble(id: string, metadata?: Record<string, unknown>): AppMessage {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    content: [{ type: 'text', text: `text of ${id}` }],
    createdAt: '2026-08-31T10:00:00.000Z',
    metadata,
  } as AppMessage;
}

function queuedInput(promptId: string): AppQueuedInput {
  return { promptId, content: [{ type: 'text', text: promptId }], createdAt: '2026-11-06T00:00:00.000Z' };
}

let sidSeq = 0;
function sid(): string {
  sidSeq += 1;
  return `s-${sidSeq}`;
}

beforeEach(() => {
  memStorage.clear();
  sessionsStore().setActiveSessionId(undefined);
  const store = promptStore();
  store.queueBySession = {};
  store.inFlightBySession = {};
  store.optimisticMessagesBySession = {};
  store.setDraftEntry('newChat');
});

describe('queue mirror', () => {
  it('setQueue replaces the session queue and clearQueue drops it', () => {
    const s = sid();
    const other = sid();
    promptStore().setQueue(s, [queuedInput('a'), queuedInput('b')]);
    promptStore().setQueue(other, [queuedInput('x')]);
    promptStore().setQueue(s, [queuedInput('b')]);

    expect(promptStore().queueBySession[s]?.map((entry) => entry.promptId)).toEqual(['b']);
    promptStore().clearQueue(s);
    expect(promptStore().queueBySession[s]).toBeUndefined();
    expect(promptStore().queueBySession[other]).toHaveLength(1);
  });

  it('drops the session key when the queue frame is empty', () => {
    const store = promptStore();
    store.setQueue('s1', [queuedInput('p1')]);
    expect(store.queueBySession['s1']).toHaveLength(1);
    store.setQueue('s1', []);
    expect(store.queueBySession['s1']).toBeUndefined();
  });

  it('retires queued bubbles the frame lists and keeps steer-marked ones', () => {
    const s = sid();
    promptStore().addOptimisticMessage(s, bubble('m1', { 'kimiWeb.promptId': 'p1', 'kimiWeb.queued': true }));
    promptStore().addOptimisticMessage(s, bubble('m2', { 'kimiWeb.promptId': 'p2', 'kimiWeb.steered': true, 'kimiWeb.steerPhase': 'accepted' }));
    promptStore().setQueue(s, [queuedInput('p1'), queuedInput('p2')]);
    expect(promptStore().optimisticMessagesBySession[s]?.map((m) => m.id)).toEqual(['m2']);
  });

  it('retires bubbles the first queue snapshot after a reconnect no longer lists', () => {
    const s = sid();
    promptStore().addOptimisticMessage(s, bubble('m1', { 'kimiWeb.promptId': 'p1', 'kimiWeb.queued': true }));
    promptStore().setQueue(s, []);
    expect(promptStore().optimisticMessagesBySession[s]).toHaveLength(1);
    promptStore().awaitQueueSnapshots();
    promptStore().setQueue(s, []);
    expect(promptStore().optimisticMessagesBySession[s]).toBeUndefined();
  });

  it('dropQueueEntry removes the entry from the shown and the confirmed queue', () => {
    const s = sid();
    promptStore().setQueue(s, [queuedInput('a'), queuedInput('b')]);
    promptStore().dropQueueEntry(s, 'a');
    expect(promptStore().queueBySession[s]?.map((entry) => entry.promptId)).toEqual(['b']);
    promptStore().restoreConfirmedQueue(s);
    expect(promptStore().queueBySession[s]?.map((entry) => entry.promptId)).toEqual(['b']);
  });

  it('confirmQueueMove applies an accepted move onto the confirmed queue', () => {
    const s = sid();
    promptStore().setQueue(s, [queuedInput('a'), queuedInput('b'), queuedInput('c')]);
    promptStore().confirmQueueMove(s, 'c', 'a');
    promptStore().restoreConfirmedQueue(s);
    expect(promptStore().queueBySession[s]?.map((entry) => entry.promptId)).toEqual(['c', 'a', 'b']);
  });
});

describe('movedQueue', () => {
  it('moves an entry before another or to the tail', () => {
    const queue = [queuedInput('a'), queuedInput('b'), queuedInput('c')];
    expect(movedQueue(queue, 'c', 'a')?.map((entry) => entry.promptId)).toEqual(['c', 'a', 'b']);
    expect(movedQueue(queue, 'a', undefined)?.map((entry) => entry.promptId)).toEqual(['b', 'c', 'a']);
  });

  it('returns undefined for unknown ids', () => {
    const queue = [queuedInput('a')];
    expect(movedQueue(queue, 'x', 'a')).toBeUndefined();
    expect(movedQueue(queue, 'a', 'x')).toBeUndefined();
  });
});

describe('unsettled compaction tracking', () => {
  it('notes started and settled markers and forgets them with prompt state', () => {
    const s = sid();
    expect(promptStore().hasUnsettledCompaction(s)).toBe(false);
    promptStore().noteCompactionStarted(s);
    expect(promptStore().hasUnsettledCompaction(s)).toBe(true);
    promptStore().noteCompactionSettled(s);
    expect(promptStore().hasUnsettledCompaction(s)).toBe(false);
    promptStore().noteCompactionStarted(s);
    promptStore().forgetPromptState(s);
    expect(promptStore().hasUnsettledCompaction(s)).toBe(false);
  });
});

describe('in-flight', () => {
  it('setInFlight writes the flag per session', () => {
    const s = sid();
    promptStore().setInFlight(s, true);
    expect(promptStore().inFlightBySession[s]).toBe(true);
    promptStore().setInFlight(s, false);
    expect(promptStore().inFlightBySession[s]).toBe(false);
  });
});

describe('optimistic bubbles', () => {
  it('addOptimisticMessage appends in order', () => {
    const s = sid();
    promptStore().addOptimisticMessage(s, bubble('m1'));
    promptStore().addOptimisticMessage(s, bubble('m2'));
    expect((promptStore().optimisticMessagesBySession[s] ?? []).map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('setOptimisticMessages replaces the list and drops the key when empty', () => {
    const s = sid();
    promptStore().addOptimisticMessage(s, bubble('m1'));
    promptStore().setOptimisticMessages(s, [bubble('m9')]);
    expect((promptStore().optimisticMessagesBySession[s] ?? []).map((m) => m.id)).toEqual(['m9']);
    promptStore().setOptimisticMessages(s, []);
    expect(promptStore().optimisticMessagesBySession[s]).toBeUndefined();
  });

  it('removeOptimisticMessage drops by id and deletes the key on empty', () => {
    const s = sid();
    promptStore().addOptimisticMessage(s, bubble('m1'));
    promptStore().removeOptimisticMessage(s, 'm1');
    expect(promptStore().optimisticMessagesBySession[s]).toBeUndefined();
  });

  it('clearOptimisticMessages drops the whole list', () => {
    const s = sid();
    promptStore().addOptimisticMessage(s, bubble('m1'));
    promptStore().clearOptimisticMessages(s);
    expect(promptStore().optimisticMessagesBySession[s]).toBeUndefined();
  });
});

describe('first-prompt lock / draft entry', () => {
  it('tryBeginStartingFirstPrompt claims once; end releases', () => {
    const wid = `w-${sid()}`;
    const store = promptStore();
    expect(store.isStartingFirstPrompt).toBe(false);
    expect(store.tryBeginStartingFirstPrompt(wid)).toBe(true);
    expect(store.isStartingFirstPrompt).toBe(true);
    expect(store.tryBeginStartingFirstPrompt(wid)).toBe(false);
    store.endStartingFirstPrompt(wid);
    expect(store.isStartingFirstPrompt).toBe(false);
    expect(store.tryBeginStartingFirstPrompt(wid)).toBe(true);
    store.endStartingFirstPrompt(wid);
  });

  it('setDraftEntry switches the draft entry kind', () => {
    expect(promptStore().draftEntry).toBe('newChat');
    promptStore().setDraftEntry('workspace');
    expect(promptStore().draftEntry).toBe('workspace');
  });
});

describe('forgetPromptState', () => {
  it('drops the compaction bookkeeping but keeps the state fields', () => {
    const s = sid();
    promptStore().setInFlight(s, true);
    promptStore().addOptimisticMessage(s, bubble('m1'));
    promptStore().noteCompactionStarted(s);

    promptStore().forgetPromptState(s);

    expect(promptStore().hasUnsettledCompaction(s)).toBe(false);
    expect(promptStore().inFlightBySession[s]).toBe(true);
    expect(promptStore().optimisticMessagesBySession[s]).toHaveLength(1);
  });
});
