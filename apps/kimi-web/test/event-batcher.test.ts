// apps/kimi-web/test/event-batcher.test.ts
// Unit tests for the streaming-event coalescing logic.
//
// These verify the batcher's behaviour (coalesce + preserve order + immediate
// passthrough for non-batchable items). They deliberately do NOT try to assert
// "Vue renders once" — that is a property of Vue's scheduler and is covered by
// manual perf verification, not by a unit test.

import { describe, expect, it } from 'vitest';
import { createEventBatcher, isRenderEvent } from '../src/composables/client/eventBatcher';
import type { AppEvent } from '../src/api/types';

interface FakeSchedule {
  schedule: (cb: () => void) => number;
  calls: () => number;
  flush: () => void;
}

// A synchronous, manually-triggered scheduler. Stores the most recent callback;
// `flush()` runs it. Lets tests drive the batcher without real rAF / timers.
function fakeSchedule(): FakeSchedule {
  let cb: (() => void) | null = null;
  let count = 0;
  return {
    schedule(fn) {
      count += 1;
      cb = fn;
      return count;
    },
    calls: () => count,
    flush() {
      const fn = cb;
      cb = null;
      fn?.();
    },
  };
}

describe('createEventBatcher', () => {
  it('coalesces consecutive batchable items into one scheduled flush, in order', () => {
    const processed: string[] = [];
    const f = fakeSchedule();
    const enqueue = createEventBatcher<string>((s) => processed.push(s), (s) => s.startsWith('d'), f.schedule);

    enqueue('d1');
    enqueue('d2');
    enqueue('d3');

    expect(processed).toEqual([]); // nothing processed yet
    expect(f.calls()).toBe(1); // scheduled exactly once

    f.flush();
    expect(processed).toEqual(['d1', 'd2', 'd3']);
  });

  it('applies a non-batchable item immediately when the queue is empty', () => {
    const processed: string[] = [];
    const f = fakeSchedule();
    const enqueue = createEventBatcher<string>((s) => processed.push(s), (s) => s.startsWith('d'), f.schedule);

    enqueue('X');

    expect(processed).toEqual(['X']);
    expect(f.calls()).toBe(0); // never scheduled
  });

  it('drains pending batchables before applying an immediate item', () => {
    const processed: string[] = [];
    const f = fakeSchedule();
    const enqueue = createEventBatcher<string>((s) => processed.push(s), (s) => s.startsWith('d'), f.schedule);

    enqueue('d1');
    enqueue('d2');
    enqueue('X'); // immediate → must flush d1, d2 first

    expect(processed).toEqual(['d1', 'd2', 'X']);

    // The rAF scheduled for d1 is now stale; firing it must be a harmless no-op.
    f.flush();
    expect(processed).toEqual(['d1', 'd2', 'X']);
  });

  it('preserves arrival order across mixed batchable and immediate items', () => {
    const processed: string[] = [];
    const f = fakeSchedule();
    const enqueue = createEventBatcher<string>((s) => processed.push(s), (s) => s.startsWith('d'), f.schedule);

    enqueue('d1'); // queued
    enqueue('d2'); // queued
    enqueue('A'); // immediate → drains d1, d2, then A
    enqueue('d3'); // queued again
    f.flush(); // drains d3

    expect(processed).toEqual(['d1', 'd2', 'A', 'd3']);
  });

  it('reschedules after a flush when new batchable items arrive', () => {
    const processed: string[] = [];
    const f = fakeSchedule();
    const enqueue = createEventBatcher<string>((s) => processed.push(s), (s) => s.startsWith('d'), f.schedule);

    enqueue('d1');
    f.flush();
    expect(processed).toEqual(['d1']);

    enqueue('d2');
    expect(f.calls()).toBe(2); // scheduled a second time

    f.flush();
    expect(processed).toEqual(['d1', 'd2']);
  });

  it('flush() drains pending batchables synchronously without the scheduler', () => {
    const processed: string[] = [];
    const f = fakeSchedule();
    const enqueue = createEventBatcher<string>((s) => processed.push(s), (s) => s.startsWith('d'), f.schedule);

    enqueue('d1');
    enqueue('d2');
    expect(processed).toEqual([]);

    enqueue.flush(); // synchronous drain, no scheduler callback needed
    expect(processed).toEqual(['d1', 'd2']);
  });

  it('flush() on an empty queue is a no-op', () => {
    const processed: string[] = [];
    const f = fakeSchedule();
    const enqueue = createEventBatcher<string>((s) => processed.push(s), (s) => s.startsWith('d'), f.schedule);

    enqueue.flush();
    expect(processed).toEqual([]);
  });
});

describe('isRenderEvent', () => {
  it.each(['assistantDelta', 'agentDelta', 'toolOutput', 'taskProgress'])(
    'treats %s as batchable',
    (type) => {
      expect(isRenderEvent({ type } as AppEvent)).toBe(true);
    },
  );

  it.each(['messageCreated', 'messageUpdated', 'sessionStatusChanged', 'approvalRequested', 'configChanged'])(
    'treats %s as immediate',
    (type) => {
      expect(isRenderEvent({ type } as AppEvent)).toBe(false);
    },
  );
});
