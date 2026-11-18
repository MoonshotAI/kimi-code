import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { access, mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DIAGNOSTICS_RETENTION_MS,
  MAX_CRASH_DUMP_BYTES,
  listCrashDumps,
  pruneDiagnosticFiles,
  rotatedLogIndex,
  selectExpiredFiles,
} from '../../../src/main/diagnostics/log-retention';

vi.mock('electron', () => ({ dialog: { showErrorBox: vi.fn() }, app: {} }));

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 29, 12);

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kimi-retention-'));
}

async function fileAt(path: string, ageDays: number, bytes = 16): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes, 'x'));
  const when = new Date(NOW - ageDays * DAY_MS);
  await utimes(path, when, when);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('selectExpiredFiles', () => {
  const file = (path: string, ageDays: number, size = 1) => ({ path, mtimeMs: NOW - ageDays * DAY_MS, size });

  it('expires files older than the age limit', () => {
    const files = [file('new', 1), file('old', 31)];
    expect(selectExpiredFiles(files, NOW, { maxAgeMs: 30 * DAY_MS })).toEqual(['old']);
  });

  it('keeps only the newest files when a count limit applies', () => {
    const files = [file('c', 3), file('a', 1), file('b', 2)];
    expect(selectExpiredFiles(files, NOW, { maxAgeMs: 30 * DAY_MS, maxFiles: 2 })).toEqual(['c']);
  });

  it('drops older files once the byte budget is spent but always keeps the newest one', () => {
    const files = [file('huge-newest', 0, 80), file('older', 1, 30), file('oldest', 2, 10)];
    expect(selectExpiredFiles(files, NOW, { maxAgeMs: 30 * DAY_MS, maxTotalBytes: 50 })).toEqual(['older', 'oldest']);
  });
});

describe('rotatedLogIndex', () => {
  it('recognizes numbered rotations of the desktop log only', () => {
    expect(rotatedLogIndex('kimi-code-desktop.log.1')).toBe(1);
    expect(rotatedLogIndex('kimi-code-desktop.log.12')).toBe(12);
    expect(rotatedLogIndex('kimi-code-desktop.log')).toBeNull();
    expect(rotatedLogIndex('kimi-code-desktop.log.bak')).toBeNull();
    expect(rotatedLogIndex('kimi-code.log.1')).toBeNull();
  });
});

describe('pruneDiagnosticFiles', () => {
  it('removes expired and surplus rotated desktop logs but never the active log or other logs', async () => {
    const root = await freshRoot();
    const active = await fileAt(join(root, 'kimi-code-desktop.log'), 400);
    const recent = await fileAt(join(root, 'kimi-code-desktop.log.1'), 2);
    const expired = await fileAt(join(root, 'kimi-code-desktop.log.2'), 31);
    const surplus = await fileAt(join(root, 'kimi-code-desktop.log.6'), 1);
    const coreLog = await fileAt(join(root, 'kimi-code.log.3'), 90);

    expect(await pruneDiagnosticFiles(NOW, [root])).toBe(2);

    expect(await exists(active)).toBe(true);
    expect(await exists(recent)).toBe(true);
    expect(await exists(expired)).toBe(false);
    expect(await exists(surplus)).toBe(false);
    expect(await exists(coreLog)).toBe(true);
  });

  it('keeps at most twenty recent incident snapshots', async () => {
    const root = await freshRoot();
    const incidents = join(root, 'desktop-incidents');
    for (let i = 0; i < 22; i += 1) {
      await fileAt(join(incidents, `incident-${String(i).padStart(2, '0')}.json`), i * 0.01);
    }
    const stale = await fileAt(join(incidents, 'stale.json'), 40);
    const note = await fileAt(join(incidents, 'notes.txt'), 40);

    expect(await pruneDiagnosticFiles(NOW, [root])).toBe(3);

    expect(await exists(join(incidents, 'incident-00.json'))).toBe(true);
    expect(await exists(join(incidents, 'incident-19.json'))).toBe(true);
    expect(await exists(join(incidents, 'incident-20.json'))).toBe(false);
    expect(await exists(join(incidents, 'incident-21.json'))).toBe(false);
    expect(await exists(stale)).toBe(false);
    expect(await exists(note)).toBe(true);
  });

  it('caps crash dumps across channels by age, count and total size', async () => {
    const root = await freshRoot();
    const crashes = join(root, 'desktop-crashes');
    const fresh = await fileAt(join(crashes, 'stable', 'completed', 'a.dmp'), 1, 1024);
    const canary = await fileAt(join(crashes, 'canary', 'pending', 'b.dmp'), 2, 1024);
    const old = await fileAt(join(crashes, 'stable', 'completed', 'c.dmp'), DIAGNOSTICS_RETENTION_MS / DAY_MS + 1);
    const settings = await fileAt(join(crashes, 'stable', 'settings.dat'), 90);

    expect(await pruneDiagnosticFiles(NOW, [root])).toBe(1);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(canary)).toBe(true);
    expect(await exists(old)).toBe(false);
    expect(await exists(settings)).toBe(true);

    const big = await fileAt(join(crashes, 'stable', 'completed', 'big.dmp'), 0.5, MAX_CRASH_DUMP_BYTES);
    expect(await pruneDiagnosticFiles(NOW, [root])).toBe(2);
    expect(await exists(big)).toBe(true);
    expect(await exists(fresh)).toBe(false);
    expect(await exists(canary)).toBe(false);
  });

  it('tolerates a missing logs directory', async () => {
    expect(await pruneDiagnosticFiles(NOW, [join(tmpdir(), 'kimi-retention-missing', String(Math.random()))])).toBe(0);
  });

  it('applies the crash dump caps across every diagnostic root', async () => {
    const startupRoot = await freshRoot();
    const currentRoot = await freshRoot();
    for (let i = 0; i < 6; i += 1) {
      await fileAt(join(startupRoot, 'desktop-crashes', 'stable', 'completed', `startup-${i}.dmp`), 1 + i);
      await fileAt(join(currentRoot, 'desktop-crashes', 'stable', 'completed', `current-${i}.dmp`), 1.5 + i);
    }
    expect(await pruneDiagnosticFiles(NOW, [currentRoot, startupRoot, currentRoot])).toBe(2);
    expect(await exists(join(startupRoot, 'desktop-crashes', 'stable', 'completed', 'startup-5.dmp'))).toBe(false);
    expect(await exists(join(currentRoot, 'desktop-crashes', 'stable', 'completed', 'current-5.dmp'))).toBe(false);
    expect(await exists(join(currentRoot, 'desktop-crashes', 'stable', 'completed', 'current-4.dmp'))).toBe(true);
  });
});

describe('scheduleDiagnosticPruning', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('also prunes the crash root remembered before KIMI_CODE_HOME moved', async () => {
    vi.resetModules();
    const startupRoot = await freshRoot();
    const movedHome = await freshRoot();
    const expired = join(startupRoot, 'desktop-crashes', 'stable', 'completed', 'expired.dmp');
    await mkdir(join(expired, '..'), { recursive: true });
    await writeFile(expired, 'MDMP');
    const longAgo = new Date(Date.now() - 45 * DAY_MS);
    await utimes(expired, longAgo, longAgo);
    const { addDiagnosticRoot } = await import('../../../src/main/diagnostics/log');
    const { scheduleDiagnosticPruning } = await import('../../../src/main/diagnostics/log-retention');
    addDiagnosticRoot(startupRoot);
    vi.stubEnv('KIMI_CODE_HOME', movedHome);
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });

    scheduleDiagnosticPruning();
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    await vi.waitFor(async () => expect(await exists(expired)).toBe(false));
  });
});

describe('listCrashDumps', () => {
  it('finds minidumps nested under channel and report folders only', async () => {
    const root = await freshRoot();
    await fileAt(join(root, 'stable', 'completed', 'one.dmp'), 1);
    await fileAt(join(root, 'canary', 'reports', 'two.dmp'), 1);
    await fileAt(join(root, 'stable', 'completed', 'one.meta'), 1);
    const dumps = await listCrashDumps(root);
    expect(dumps.map((dump) => dump.path).sort()).toEqual([
      join(root, 'canary', 'reports', 'two.dmp'),
      join(root, 'stable', 'completed', 'one.dmp'),
    ]);
  });
});
