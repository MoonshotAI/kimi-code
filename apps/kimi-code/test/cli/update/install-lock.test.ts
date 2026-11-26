import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tryAcquireUpdateInstallLock } from '#/cli/update/install-lock';
import { getUpdateInstallLockFile } from '#/utils/paths';

const fsMocks = vi.hoisted(() => ({
  linkError: null as string | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (
      src: Parameters<typeof actual.link>[0],
      dst: Parameters<typeof actual.link>[1],
    ) => {
      if (fsMocks.linkError !== null) {
        throw Object.assign(new Error('link() is not supported (mocked)'), {
          code: fsMocks.linkError,
        });
      }
      return actual.link(src, dst);
    },
  };
});

const originalEnv = { ...process.env };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kimi-update-install-lock-'));
  process.env['KIMI_CODE_HOME'] = dir;
  fsMocks.linkError = null;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('update install lock', () => {
  it('allows only one holder until the lock is released', async () => {
    const first = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(first).not.toBeNull();
    expect(getUpdateInstallLockFile()).toBe(join(dir, 'updates', 'install.lock'));

    const second = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(second).toBeNull();

    await first?.release();

    const third = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(third).not.toBeNull();
    await third?.release();
  });

  it('grants the lock to exactly one of many concurrent acquirers', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => tryAcquireUpdateInstallLock({ version: '0.5.0' })),
    );
    const winners = attempts.filter((handle) => handle !== null);
    expect(winners).toHaveLength(1);
    const held = JSON.parse(readFileSync(getUpdateInstallLockFile(), 'utf-8')) as {
      version: string;
    };
    expect(held.version).toBe('0.5.0');
    await winners[0]?.release();
  });

  it('grants exactly one winner when racing to take over a stale lock', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    writeAgedLock(child.pid ?? -1);

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => tryAcquireUpdateInstallLock({ version: '0.5.0' })),
    );
    const winners = attempts.filter((handle) => handle !== null);
    expect(winners).toHaveLength(1);
    await winners[0]?.release();
  });

  it('recovers from a corrupt lock file', async () => {
    const filePath = getUpdateInstallLockFile();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{', 'utf-8');
    const old = new Date(Date.now() - 2 * 60 * 1000);
    utimesSync(filePath, old, old);

    const lock = await tryAcquireUpdateInstallLock({ version: '0.5.0' });

    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it('treats a young unparseable lock as a publish in progress', async () => {
    const filePath = getUpdateInstallLockFile();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{', 'utf-8');

    const lock = await tryAcquireUpdateInstallLock({ version: '0.5.0' });

    expect(lock).toBeNull();
  });

  it('acquires, excludes and releases on filesystems without hard-link support', async () => {
    fsMocks.linkError = 'ENOTSUP';

    const first = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(first).not.toBeNull();
    expect(await tryAcquireUpdateInstallLock({ version: '0.5.0' })).toBeNull();

    await first?.release();
    const again = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(again).not.toBeNull();
    await again?.release();
  });

  it('grants exactly one winner under concurrent exclusive-create publishes', async () => {
    fsMocks.linkError = 'ENOTSUP';

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => tryAcquireUpdateInstallLock({ version: '0.5.0' })),
    );
    const winners = attempts.filter((handle) => handle !== null);
    expect(winners).toHaveLength(1);
    await winners[0]?.release();
  });

  it('takes over a stale lock without hard-link support', async () => {
    fsMocks.linkError = 'ENOTSUP';
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    writeAgedLock(child.pid ?? -1);

    const lock = await tryAcquireUpdateInstallLock({ version: '0.5.0' });

    expect(lock).not.toBeNull();
    await lock?.release();
  });

  function writeAgedLock(pid: number): void {
    const filePath = getUpdateInstallLockFile();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `${JSON.stringify({
        version: '0.5.0',
        pid,
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      })}\n`,
      'utf-8',
    );
  }

  it('does not treat an aged lock as stale while its holder process is alive', async () => {
    const holder = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(holder).not.toBeNull();

    const lock = await tryAcquireUpdateInstallLock({
      version: '0.5.0',
      now: new Date(Date.now() + 60 * 60 * 1000),
    });

    expect(lock).toBeNull();
    await holder?.release();
  });

  it.runIf(process.platform !== 'win32')('sweeps an aged lock whose pid now belongs to a process started after it', async () => {
    const reused = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => reused.once('spawn', resolve));
      writeAgedLock(reused.pid ?? -1);

      const lock = await tryAcquireUpdateInstallLock({ version: '0.5.0' });

      expect(lock).not.toBeNull();
      await lock?.release();
    } finally {
      reused.kill('SIGKILL');
    }
  });

  it('sweeps an aged lock whose holder process is gone', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    writeAgedLock(child.pid ?? -1);

    const lock = await tryAcquireUpdateInstallLock({ version: '0.5.0' });

    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it('sweeps a young lock whose holder process is gone', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    const filePath = getUpdateInstallLockFile();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `${JSON.stringify({
        version: '0.5.0',
        pid: child.pid ?? -1,
        startedAt: new Date().toISOString(),
      })}\n`,
      'utf-8',
    );

    const lock = await tryAcquireUpdateInstallLock({ version: '0.5.0' });

    expect(lock).not.toBeNull();
    await lock?.release();
  });
});
