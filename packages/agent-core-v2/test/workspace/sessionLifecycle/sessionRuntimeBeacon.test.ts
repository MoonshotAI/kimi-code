import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCodes, isError2 } from '#/errors';
import {
  assertNoActiveRuntimeElsewhere,
  isRuntimeRecordActive,
  listSessionRuntimeEntries,
  readSessionRuntimeRecord,
  resolveRuntimeProcess,
  SESSION_RUNTIME_ACTIVE_TTL_MS,
  SESSION_RUNTIME_HEARTBEAT_MS,
  SessionRuntimeBeacon,
  sessionRuntimeDirOf,
  sessionRuntimePathOf,
  type SessionRuntimeRecord,
} from '#/workspace/sessionLifecycle/sessionRuntimeBeacon';

const OTHER_PID = 99_999_999;

function writeRecord(sessionsDir: string, record: SessionRuntimeRecord): void {
  const dir = sessionRuntimeDirOf(sessionsDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.sessionId}.json`), JSON.stringify(record));
}

function recordFixture(patch: Partial<SessionRuntimeRecord>): SessionRuntimeRecord {
  return {
    sessionId: 'session_a',
    workspaceId: 'wd_a',
    pid: OTHER_PID,
    process: 'cli-print',
    startedAt: 1_000,
    ts: 1_000,
    ...patch,
  };
}

describe('resolveRuntimeProcess', () => {
  it('marks nonInteractive hosts as cli-print', () => {
    expect(resolveRuntimeProcess({ requestHeaders: {}, nonInteractive: true })).toBe('cli-print');
    expect(
      resolveRuntimeProcess({ requestHeaders: {}, nonInteractive: true, hostKind: 'server' }),
    ).toBe('cli-print');
  });

  it('uses the explicit host kind otherwise, defaulting to cli', () => {
    expect(resolveRuntimeProcess({ requestHeaders: {}, hostKind: 'server' })).toBe('server');
    expect(resolveRuntimeProcess({ requestHeaders: {} })).toBe('cli');
  });
});

describe('SessionRuntimeBeacon', () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'kimi-runtime-beacon-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('writes the record on start, refreshes ts on the interval, and marks stoppedAt on stop', () => {
    const beacon = new SessionRuntimeBeacon(sessionsDir, 'session_a', 'wd_a', 'cli-print');
    beacon.start();
    const path = sessionRuntimePathOf(sessionsDir, 'session_a');
    const first = readSessionRuntimeRecord(path);
    expect(first).toMatchObject({
      sessionId: 'session_a',
      workspaceId: 'wd_a',
      pid: process.pid,
      process: 'cli-print',
      ts: Date.now(),
    });
    expect(first?.startedAt).toBe(Date.now());
    expect(first?.stoppedAt).toBeUndefined();

    vi.advanceTimersByTime(SESSION_RUNTIME_HEARTBEAT_MS);
    const refreshed = readSessionRuntimeRecord(path);
    expect(refreshed?.ts).toBe(Date.now());
    expect(refreshed?.ts).toBeGreaterThan(first!.ts);
    expect(refreshed?.startedAt).toBe(first!.startedAt);

    beacon.stop();
    const stopped = readSessionRuntimeRecord(path);
    expect(stopped?.stoppedAt).toBe(Date.now());

    vi.advanceTimersByTime(SESSION_RUNTIME_HEARTBEAT_MS * 2);
    const after = readSessionRuntimeRecord(path);
    expect(after?.ts).toBe(stopped?.ts);
  });

  it('does not hold the event loop open', () => {
    const beacon = new SessionRuntimeBeacon(sessionsDir, 'session_a', 'wd_a', 'cli');
    beacon.start();
    const timer = (beacon as unknown as { timer?: { hasRef(): boolean } }).timer;
    expect(timer?.hasRef()).toBe(false);
    beacon.stop();
  });

  it('keeps stop idempotent', () => {
    const beacon = new SessionRuntimeBeacon(sessionsDir, 'session_a', 'wd_a', 'server');
    beacon.start();
    beacon.stop();
    const stopped = readSessionRuntimeRecord(sessionRuntimePathOf(sessionsDir, 'session_a'));
    beacon.stop();
    const again = readSessionRuntimeRecord(sessionRuntimePathOf(sessionsDir, 'session_a'));
    expect(again).toEqual(stopped);
  });
});

describe('assertNoActiveRuntimeElsewhere', () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'kimi-runtime-guard-'));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('throws session.active_in_another_process for a fresh record owned by another pid', () => {
    writeRecord(sessionsDir, recordFixture({ ts: Date.now() }));
    let caught: unknown;
    try {
      assertNoActiveRuntimeElsewhere(sessionsDir, 'session_a');
    } catch (error) {
      caught = error;
    }
    expect(isError2(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe(ErrorCodes.SESSION_ACTIVE_IN_ANOTHER_PROCESS);
    expect((caught as { details?: unknown }).details).toEqual({
      pid: OTHER_PID,
      process: 'cli-print',
    });
  });

  it('lets the owning process through', () => {
    writeRecord(sessionsDir, recordFixture({ ts: Date.now(), pid: process.pid }));
    expect(() => {
      assertNoActiveRuntimeElsewhere(sessionsDir, 'session_a');
    }).not.toThrow();
  });

  it('lets stopped records through', () => {
    writeRecord(sessionsDir, recordFixture({ ts: Date.now(), stoppedAt: Date.now() }));
    expect(() => {
      assertNoActiveRuntimeElsewhere(sessionsDir, 'session_a');
    }).not.toThrow();
  });

  it('lets stale records through so crash residue expires', () => {
    writeRecord(
      sessionsDir,
      recordFixture({ ts: Date.now() - SESSION_RUNTIME_ACTIVE_TTL_MS - 1 }),
    );
    expect(() => {
      assertNoActiveRuntimeElsewhere(sessionsDir, 'session_a');
    }).not.toThrow();
  });

  it('lets missing or corrupt records through', () => {
    expect(() => {
      assertNoActiveRuntimeElsewhere(sessionsDir, 'session_a');
    }).not.toThrow();
    const dir = sessionRuntimeDirOf(sessionsDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session_a.json'), '{not json');
    expect(() => {
      assertNoActiveRuntimeElsewhere(sessionsDir, 'session_a');
    }).not.toThrow();
  });
});

describe('listSessionRuntimeEntries', () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'kimi-runtime-list-'));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('keeps active and recently stopped non-server records, sorted active first then freshest', () => {
    const now = Date.now();
    writeRecord(sessionsDir, recordFixture({ sessionId: 'active-old', ts: now - 5_000 }));
    writeRecord(sessionsDir, recordFixture({ sessionId: 'active-new', ts: now - 1_000 }));
    writeRecord(
      sessionsDir,
      recordFixture({ sessionId: 'stopped-recent', ts: now - 60_000, stoppedAt: now - 60_000 }),
    );
    writeRecord(
      sessionsDir,
      recordFixture({
        sessionId: 'stopped-old',
        ts: now - 49 * 3_600_000,
        stoppedAt: now - 49 * 3_600_000,
      }),
    );
    writeRecord(sessionsDir, recordFixture({ sessionId: 'server-live', process: 'server', ts: now }));
    writeRecord(
      sessionsDir,
      recordFixture({ sessionId: 'crashed', ts: now - SESSION_RUNTIME_ACTIVE_TTL_MS - 1 }),
    );

    const entries = listSessionRuntimeEntries(sessionsDir, now);
    expect(entries.map((entry) => entry.record.sessionId)).toEqual([
      'active-new',
      'active-old',
      'stopped-recent',
    ]);
    expect(entries[0]?.active).toBe(true);
    expect(entries[2]?.active).toBe(false);
  });

  it('prunes records whose ts is older than seven days', () => {
    const now = Date.now();
    writeRecord(
      sessionsDir,
      recordFixture({
        sessionId: 'ancient',
        ts: now - 8 * 86_400_000,
        stoppedAt: now - 8 * 86_400_000,
      }),
    );
    writeRecord(sessionsDir, recordFixture({ sessionId: 'fresh', ts: now }));

    const entries = listSessionRuntimeEntries(sessionsDir, now);
    expect(entries.map((entry) => entry.record.sessionId)).toEqual(['fresh']);
    expect(readSessionRuntimeRecord(sessionRuntimePathOf(sessionsDir, 'ancient'))).toBeUndefined();
  });

  it('ignores corrupt files and non-json siblings', () => {
    const dir = sessionRuntimeDirOf(sessionsDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{oops');
    writeFileSync(join(dir, 'note.txt'), 'hello');
    expect(listSessionRuntimeEntries(sessionsDir)).toEqual([]);
  });
});

describe('isRuntimeRecordActive', () => {
  it('requires a fresh ts and no stoppedAt', () => {
    const now = Date.now();
    expect(isRuntimeRecordActive(recordFixture({ ts: now }), now)).toBe(true);
    expect(isRuntimeRecordActive(recordFixture({ ts: now, stoppedAt: now }), now)).toBe(false);
    expect(
      isRuntimeRecordActive(recordFixture({ ts: now - SESSION_RUNTIME_ACTIVE_TTL_MS - 1 }), now),
    ).toBe(false);
  });
});
