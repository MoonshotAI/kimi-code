import { describe, expect, it } from 'vitest';
import type { AppSession } from '../src/api/types';
import { mergeSnapshotSession } from '../src/api/daemon/mappers';

const T = {
  older: '2026-08-10T23:00:00.000Z',
  newer: '2026-08-11T04:00:00.000Z',
} as const;

function session(over: Partial<AppSession> = {}): AppSession {
  return {
    id: 's1',
    title: 't',
    createdAt: T.older,
    updatedAt: T.older,
    busy: false,
    archived: false,
    cwd: '/w',
    model: 'kimi-code',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
    ...over,
  };
}

const liveUsage: AppSession['usage'] = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalCostUsd: 0,
  contextTokens: 1234,
  contextLimit: 200000,
  turnCount: 3,
};

describe('mergeSnapshotSession', () => {
  it('keeps the pooled live usage when the snapshot ships the placeholder', () => {
    const pooled = session({ usage: liveUsage });
    const snap = session(); // all-zero placeholder
    expect(mergeSnapshotSession(pooled, snap, false).usage).toBe(liveUsage);
  });

  it('adopts the snapshot usage when it carries real values', () => {
    const pooled = session({ usage: liveUsage });
    const snapUsage = { ...liveUsage, contextTokens: 9999 };
    const snap = session({ usage: snapUsage });
    expect(mergeSnapshotSession(pooled, snap, false).usage).toBe(snapUsage);
  });

  it('keeps the pooled model when the snapshot could not resolve one', () => {
    const pooled = session({ model: 'kimi-code' });
    expect(mergeSnapshotSession(pooled, session({ model: '' }), false).model).toBe('kimi-code');
    expect(mergeSnapshotSession(pooled, session({ model: 'other' }), false).model).toBe('other');
  });

  it('adopts a newer server updatedAt only while the main turn is not running', () => {
    const pooled = session({ updatedAt: T.older });
    expect(mergeSnapshotSession(pooled, session({ updatedAt: T.newer }), false).updatedAt).toBe(T.newer);
    // Mid-turn the server bumps (prompt submit, auto title, subagent
    // registration) — importing that on click floats the session early. The
    // caller passes the snapshot's EFFECTIVE main-turn liveness (older daemons
    // omit the field), so the guard keys off the parameter, not the field.
    expect(
      mergeSnapshotSession(pooled, session({ updatedAt: T.newer, mainTurnActive: true }), true)
        .updatedAt,
    ).toBe(T.older);
    expect(
      mergeSnapshotSession(pooled, session({ updatedAt: T.newer }), true).updatedAt,
    ).toBe(T.older);
  });

  it('never moves recency backwards (a newer local bump survives)', () => {
    const pooled = session({ updatedAt: T.newer });
    expect(mergeSnapshotSession(pooled, session({ updatedAt: T.older }), false).updatedAt).toBe(T.newer);
  });

  it('preserves the pooled pullRequest across v1 snapshots; adopts a carried one', () => {
    const pr = { number: 42, state: 'open' as const, url: 'https://x/pr/42' };
    const pooled = session({ pullRequest: pr });
    // v1 snapshot path: field absent → preserved.
    expect(mergeSnapshotSession(pooled, session(), false).pullRequest).toBe(pr);
    // checked-no-PR is a fact too and survives the same way.
    const noPr = session({ pullRequest: null });
    expect(mergeSnapshotSession(noPr, session(), false).pullRequest).toBeNull();
    // a snapshot that does carry the domain wins.
    const snapPr = { number: 7, state: 'merged' as const, url: 'https://x/pr/7' };
    expect(mergeSnapshotSession(pooled, session({ pullRequest: snapPr }), false).pullRequest).toBe(snapPr);
  });

  it('takes the snapshot for everything else (title/busy/lastTurnReason…)', () => {
    const pooled = session({ title: 'old', busy: false });
    const snap = session({ title: 'new', busy: true, lastTurnReason: 'failed' });
    const merged = mergeSnapshotSession(pooled, snap, false);
    expect(merged.title).toBe('new');
    expect(merged.busy).toBe(true);
    expect(merged.lastTurnReason).toBe('failed');
  });
});
