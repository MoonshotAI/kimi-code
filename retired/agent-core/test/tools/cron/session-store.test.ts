/**
 * Tests for `tools/cron/session-store.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  SessionCronStore,
  type SessionCronTaskInit,
} from '../../../src/tools/cron/session-store';

const ID_REGEX = /^[0-9a-f]{8}$/;

/** Convenience: minimal valid init that varies by suffix so tests can
 *  tell two tasks apart in `list()` snapshots. */
function makeInit(suffix: string, overrides: Partial<SessionCronTaskInit> = {}): SessionCronTaskInit {
  return {
    cron: '*/5 * * * *',
    prompt: `prompt-${suffix}`,
    recurring: true,
    ...overrides,
  };
}

describe('SessionCronStore', () => {
  describe('add', () => {
    it('returns a task with id matching /^[0-9a-f]{8}$/', () => {
      const store = new SessionCronStore();
      const task = store.add(makeInit('a'), 1000);
      expect(task.id).toMatch(ID_REGEX);
    });

    it('preserves cron / prompt / recurring from the init', () => {
      const store = new SessionCronStore();
      const init: SessionCronTaskInit = {
        cron: '0 9 * * 1-5',
        prompt: 'sync PRs',
        recurring: true,
      };
      const task = store.add(init, 1000);
      expect(task.cron).toBe('0 9 * * 1-5');
      expect(task.prompt).toBe('sync PRs');
      expect(task.recurring).toBe(true);
    });

    it('sets createdAt to the supplied nowMs (no internal clock read)', () => {
      const store = new SessionCronStore();
      const task = store.add(makeInit('a'), 1_700_000_000_000);
      expect(task.createdAt).toBe(1_700_000_000_000);
    });

    it('does not consult Date.now()', () => {
      // Sentinel: a nowMs deliberately not close to "now" makes
      // accidental Date.now() use obvious in createdAt.
      const store = new SessionCronStore();
      const task = store.add(makeInit('a'), 0);
      expect(task.createdAt).toBe(0);
    });

    it('rapid sequential adds produce distinct ids', () => {
      const store = new SessionCronStore();
      const ids = new Set<string>();
      for (let i = 0; i < 32; i++) {
        ids.add(store.add(makeInit(`x${i}`), 1000 + i).id);
      }
      expect(ids.size).toBe(32);
    });
  });

  describe('get', () => {
    it('returns a previously-added task', () => {
      const store = new SessionCronStore();
      const task = store.add(makeInit('a'), 1000);
      expect(store.get(task.id)).toEqual(task);
    });

    it('returns undefined for an unknown id', () => {
      const store = new SessionCronStore();
      expect(store.get('deadbeef')).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns tasks in insertion order', () => {
      const store = new SessionCronStore();
      const t1 = store.add(makeInit('1'), 1000);
      const t2 = store.add(makeInit('2'), 1001);
      const t3 = store.add(makeInit('3'), 1002);
      expect(store.list().map((t) => t.id)).toEqual([t1.id, t2.id, t3.id]);
    });

    it('returns a fresh array on each call (no aliasing)', () => {
      const store = new SessionCronStore();
      store.add(makeInit('a'), 1000);
      const a = store.list();
      const b = store.list();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it('mutating the returned array does not affect the store', () => {
      const store = new SessionCronStore();
      store.add(makeInit('a'), 1000);
      const snap = store.list() as unknown as CronTaskLike[];
      snap.length = 0;
      expect(store.list()).toHaveLength(1);
    });

    it('returns empty array on a fresh store', () => {
      const store = new SessionCronStore();
      expect(store.list()).toEqual([]);
    });
  });

  describe('remove', () => {
    it('returns only the ids that were actually present', () => {
      const store = new SessionCronStore();
      const t1 = store.add(makeInit('1'), 1000);
      const t2 = store.add(makeInit('2'), 1001);
      const removed = store.remove([t1.id, 'missing0', t2.id]);
      expect(removed).toEqual([t1.id, t2.id]);
    });

    it('actually removes the tasks from list / get', () => {
      const store = new SessionCronStore();
      const t1 = store.add(makeInit('1'), 1000);
      store.remove([t1.id]);
      expect(store.get(t1.id)).toBeUndefined();
      expect(store.list()).toHaveLength(0);
    });

    it('returns empty array when nothing matches', () => {
      const store = new SessionCronStore();
      store.add(makeInit('a'), 1000);
      expect(store.remove(['ffffffff', 'eeeeeeee'])).toEqual([]);
    });

    it('preserves insertion order of remaining tasks', () => {
      const store = new SessionCronStore();
      const t1 = store.add(makeInit('1'), 1000);
      const t2 = store.add(makeInit('2'), 1001);
      const t3 = store.add(makeInit('3'), 1002);
      store.remove([t2.id]);
      expect(store.list().map((t) => t.id)).toEqual([t1.id, t3.id]);
    });
  });

  describe('clear', () => {
    it('empties the store', () => {
      const store = new SessionCronStore();
      store.add(makeInit('a'), 1000);
      store.add(makeInit('b'), 1001);
      store.clear();
      expect(store.list()).toEqual([]);
    });

    it('is a no-op on an already-empty store', () => {
      const store = new SessionCronStore();
      expect(() => store.clear()).not.toThrow();
      expect(store.list()).toEqual([]);
    });
  });

  describe('id uniqueness at scale', () => {
    it('256 adds produce 256 unique 8-hex ids', () => {
      const store = new SessionCronStore();
      const ids = new Set<string>();
      for (let i = 0; i < 256; i++) {
        const task = store.add(makeInit(`x${i}`), 1000 + i);
        expect(task.id).toMatch(ID_REGEX);
        ids.add(task.id);
      }
      expect(ids.size).toBe(256);
      expect(store.list()).toHaveLength(256);
    });
  });
});

/** Local alias for the mutate-snapshot test that needs a writable view
 *  of `readonly CronTask[]` without dragging in the real CronTask type. */
type CronTaskLike = { id: string };
