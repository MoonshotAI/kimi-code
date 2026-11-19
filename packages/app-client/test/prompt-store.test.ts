import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppMessage } from '@moonshot-ai/app-core/api';
import type { PromptEnvelope } from '../src/client/types';
import { sessionsStore } from '../src/stores/sessions';
import { chainSteer, promptStore } from '../src/stores/prompt';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

function envelope(text: string): PromptEnvelope {
  return { text, attachments: [], skills: [], permissionMode: undefined };
}

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

let sidSeq = 0;
function sid(): string {
  sidSeq += 1;
  return `s-${sidSeq}`;
}

beforeEach(() => {
  memStorage.clear();
  sessionsStore().setActiveSessionId(undefined);
  const store = promptStore();
  store.queuedBySession = {};
  store.inFlightBySession = {};
  store.optimisticMessagesBySession = {};
  store.setDraftEntry('newChat');
});

describe('queue actions', () => {
  it('enqueueForSession appends under the given session and assigns unique ids', () => {
    promptStore().enqueueForSession('s-active', envelope('first'), 'draft one');
    promptStore().enqueueForSession('s-active', envelope('second'));
    const queued = promptStore().queuedBySession['s-active'] ?? [];
    expect(queued.map((q) => q.text)).toEqual(['first', 'second']);
    expect(queued[0]!.editText).toBe('draft one');
    expect(queued[0]!.id).toBeTruthy();
    expect(queued[0]!.id).not.toBe(queued[1]!.id);
  });

  it('removeQueuedAt splices and reports the head change', () => {
    const s = sid();
    promptStore().restoreQueueEntry(s, { ...envelope('a'), id: 'a' });
    promptStore().restoreQueueEntry(s, { ...envelope('b'), id: 'b' });
    promptStore().restoreQueueEntry(s, { ...envelope('c'), id: 'c' });
    const removed = promptStore().removeQueuedAt(s, 1);
    expect((promptStore().queuedBySession[s] ?? []).map((q) => q.text)).toEqual(['c', 'a']);
    expect(removed?.previousHead?.text).toBe('c');
    expect(removed?.nextHead?.text).toBe('c');
    expect(promptStore().removeQueuedAt(s, 5)).toBeNull();
  });

  it('removeQueuedAt of the head reports the NEW head', () => {
    const s = sid();
    promptStore().restoreQueueEntry(s, { ...envelope('a'), id: 'a' });
    promptStore().restoreQueueEntry(s, { ...envelope('b'), id: 'b' });
    const removed = promptStore().removeQueuedAt(s, 0);
    expect(removed?.previousHead?.text).toBe('b');
    expect(removed?.nextHead?.text).toBe('a');
  });

  it('moveQueued reorders and reports the head change; invalid indices no-op', () => {
    const s = sid();
    promptStore().restoreQueueEntry(s, { ...envelope('a'), id: 'a' });
    promptStore().restoreQueueEntry(s, { ...envelope('b'), id: 'b' });
    promptStore().restoreQueueEntry(s, { ...envelope('c'), id: 'c' });
    const moved = promptStore().moveQueued(s, 0, 2);
    expect((promptStore().queuedBySession[s] ?? []).map((q) => q.text)).toEqual(['b', 'a', 'c']);
    expect(moved?.previousHead?.text).toBe('c');
    expect(moved?.nextHead?.text).toBe('b');
    expect(promptStore().moveQueued(s, 1, 1)).toBeNull();
    expect(promptStore().moveQueued(s, -1, 0)).toBeNull();
  });

  it('dropQueueHead returns and removes the head; restoreQueueEntry re-inserts at position', () => {
    const s = sid();
    promptStore().restoreQueueEntry(s, { ...envelope('a'), id: 'a' });
    promptStore().restoreQueueEntry(s, { ...envelope('b'), id: 'b' });
    const head = promptStore().dropQueueHead(s);
    expect(head?.text).toBe('b');
    expect((promptStore().queuedBySession[s] ?? []).map((q) => q.text)).toEqual(['a']);
    promptStore().restoreQueueEntry(s, head!);
    expect((promptStore().queuedBySession[s] ?? []).map((q) => q.text)).toEqual(['b', 'a']);
    expect(promptStore().dropQueueHead(sid())).toBeUndefined();
  });

  it('restoreQueueEntry clamps the index to the queue length', () => {
    const s = sid();
    promptStore().restoreQueueEntry(s, { ...envelope('a'), id: 'a' });
    promptStore().restoreQueueEntry(s, { ...envelope('b'), id: 'b' }, 99);
    expect((promptStore().queuedBySession[s] ?? []).map((q) => q.text)).toEqual(['a', 'b']);
  });

  it('enqueueCompactForSession appends a compact entry and hasQueuedCompact detects it', () => {
    const s = sid();
    expect(promptStore().hasQueuedCompact(s)).toBe(false);
    promptStore().enqueueForSession(s, envelope('note'));
    expect(promptStore().hasQueuedCompact(s)).toBe(false);
    promptStore().enqueueCompactForSession(s, 'focus on tools');
    expect(promptStore().hasQueuedCompact(s)).toBe(true);
    const queued = promptStore().queuedBySession[s] ?? [];
    expect(queued.map((q) => q.kind ?? 'prompt')).toEqual(['prompt', 'compact']);
    const compact = queued[1]!;
    expect(compact.text).toBe('/compact focus on tools');
    expect(compact.instruction).toBe('focus on tools');
    expect(compact.enqueuedAt).toBeTypeOf('number');
    expect(compact.id).toBeTruthy();
    promptStore().removeQueuedAt(s, 1);
    expect(promptStore().hasQueuedCompact(s)).toBe(false);
  });

  it('enqueueCompactForSession without instruction stores the bare command', () => {
    const s = sid();
    promptStore().enqueueCompactForSession(s);
    const compact = (promptStore().queuedBySession[s] ?? [])[0]!;
    expect(compact.text).toBe('/compact');
    expect(compact.instruction).toBeUndefined();
  });
});

describe('compact flush hold', () => {
  it('holds, releases once, and reports whether it was held', () => {
    const s = sid();
    expect(promptStore().isCompactFlushHeld(s)).toBe(false);
    promptStore().holdCompactFlush(s);
    expect(promptStore().isCompactFlushHeld(s)).toBe(true);
    expect(promptStore().releaseCompactFlush(s)).toBe(true);
    expect(promptStore().isCompactFlushHeld(s)).toBe(false);
    expect(promptStore().releaseCompactFlush(s)).toBe(false);
  });

  it('forgetPromptState drops the hold', () => {
    const s = sid();
    promptStore().holdCompactFlush(s);
    promptStore().forgetPromptState(s);
    expect(promptStore().isCompactFlushHeld(s)).toBe(false);
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

describe('flush failure budget', () => {
  it('notes, reads and clears the per-entry failure count', () => {
    const s = sid();
    expect(promptStore().queueFlushFailureFor(s)).toBeUndefined();
    promptStore().noteQueueFlushFailure(s, 'k1', 2);
    expect(promptStore().queueFlushFailureFor(s)).toEqual({ key: 'k1', count: 2 });
    promptStore().clearQueueFlushFailure(s);
    expect(promptStore().queueFlushFailureFor(s)).toBeUndefined();
  });
});

describe('steer holds and serialization', () => {
  it('holds stack and release one at a time', () => {
    const s = sid();
    expect(promptStore().isSteerInFlight(s)).toBe(false);
    promptStore().noteSteerStart(s);
    promptStore().noteSteerStart(s);
    expect(promptStore().isSteerInFlight(s)).toBe(true);
    promptStore().noteSteerSettled(s);
    expect(promptStore().isSteerInFlight(s)).toBe(true);
    promptStore().noteSteerSettled(s);
    expect(promptStore().isSteerInFlight(s)).toBe(false);
  });

  it('chainSteer runs overlapping calls in click order', async () => {
    const s = sid();
    const order: string[] = [];
    const first = chainSteer(s, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('first');
      return 'first';
    });
    const second = chainSteer(s, async () => {
      order.push('second');
      return 'second';
    });
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(order).toEqual(['first', 'second']);
  });

  it('chainSteer rides over a rejected predecessor', async () => {
    const s = sid();
    const order: string[] = [];
    const first = chainSteer(s, async () => {
      order.push('first');
      throw new Error('boom');
    });
    const second = chainSteer(s, async () => {
      order.push('second');
      return 'second';
    });
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('second');
    expect(order).toEqual(['first', 'second']);
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
  it('drops the per-session lifecycle bookkeeping but keeps the state fields', () => {
    const s = sid();
    const other = sid();
    promptStore().restoreQueueEntry(s, { ...envelope('a'), id: 'a' });
    promptStore().restoreQueueEntry(other, { ...envelope('x'), id: 'x' });
    promptStore().setInFlight(s, true);
    promptStore().addOptimisticMessage(s, bubble('m1'));
    promptStore().noteAutoCompacted(s);
    promptStore().noteSteerStart(s);
    promptStore().noteQueueFlushFailure(s, 'k', 1);
    void chainSteer(s, async () => 'done');

    promptStore().forgetPromptState(s);

    expect(promptStore().autoCompactedAt(s)).toBeUndefined();
    expect(promptStore().isSteerInFlight(s)).toBe(false);
    expect(promptStore().queueFlushFailureFor(s)).toBeUndefined();
    expect(promptStore().queuedBySession[s]).toHaveLength(1);
    expect(promptStore().inFlightBySession[s]).toBe(true);
    expect(promptStore().optimisticMessagesBySession[s]).toHaveLength(1);
    expect(promptStore().queuedBySession[other]).toHaveLength(1);
  });

  it('clearQueued / clearInFlight drop the state fields', () => {
    const s = sid();
    promptStore().restoreQueueEntry(s, { ...envelope('a'), id: 'a' });
    promptStore().setInFlight(s, true);
    promptStore().clearQueued(s);
    promptStore().clearInFlight(s);
    expect(promptStore().queuedBySession[s]).toBeUndefined();
    expect(promptStore().inFlightBySession[s]).toBeUndefined();
  });
});
