import { describe, expect, it } from 'vitest';
import { insertSessionByRecency } from '../src/lib/sessionRecency';

function s(id: string, updatedAt: string): { id: string; updatedAt: string } {
  return { id, updatedAt };
}

const T = {
  newest: '2026-08-11T04:00:00.000Z',
  middle: '2026-08-11T02:00:00.000Z',
  oldest: '2026-08-10T23:00:00.000Z',
} as const;

function ids(sessions: readonly { id: string }[]): string[] {
  return sessions.map((x) => x.id);
}

describe('insertSessionByRecency', () => {
  it('inserts into an empty pool', () => {
    expect(ids(insertSessionByRecency([], s('a', T.middle)))).toEqual(['a']);
  });

  it('lands a newest timestamp at the head', () => {
    const pool = [s('b', T.middle), s('c', T.oldest)];
    expect(ids(insertSessionByRecency(pool, s('a', T.newest)))).toEqual(['a', 'b', 'c']);
  });

  it('lands a middle timestamp in the middle', () => {
    const pool = [s('a', T.newest), s('c', T.oldest)];
    expect(ids(insertSessionByRecency(pool, s('b', T.middle)))).toEqual(['a', 'b', 'c']);
  });

  it('lands an oldest timestamp at the tail', () => {
    const pool = [s('a', T.newest), s('b', T.middle)];
    expect(ids(insertSessionByRecency(pool, s('c', T.oldest)))).toEqual(['a', 'b', 'c']);
  });

  it('replaces in place on the same id (no front-jump, no duplicate)', () => {
    const pool = [s('a', T.newest), s('b', T.middle), s('c', T.oldest)];
    const next = insertSessionByRecency(pool, { ...s('b', T.middle), id: 'b' });
    expect(ids(next)).toEqual(['a', 'b', 'c']);
  });

  it('moves to the head only when the timestamp says so (e.g. fresh activity)', () => {
    const pool = [s('a', T.newest), s('b', T.middle)];
    const next = insertSessionByRecency(pool, s('b', '2026-08-11T05:00:00.000Z'));
    expect(ids(next)).toEqual(['b', 'a']);
  });

  it('keeps the newcomer after equal timestamps (stable)', () => {
    const pool = [s('a', T.middle), s('b', T.oldest)];
    expect(ids(insertSessionByRecency(pool, s('c', T.middle)))).toEqual(['a', 'c', 'b']);
  });

  it('same-id replace with an unchanged timestamp keeps its exact slot', () => {
    // e.g. an undo touching only lastTurnReason must not slide the source
    // session behind its same-timestamp fork.
    const pool = [s('a', T.newest), s('b', T.middle), s('fork-of-b', T.middle)];
    const next = insertSessionByRecency(pool, { id: 'b', updatedAt: T.middle });
    expect(ids(next)).toEqual(['a', 'b', 'fork-of-b']);
  });
});
