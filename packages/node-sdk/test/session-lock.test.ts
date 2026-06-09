import { access, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireSessionRunLock, type KimiError } from '#/index';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeSessionDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-session-lock-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('acquireSessionRunLock', () => {
  it('creates run.lock in the session directory', async () => {
    const sessionDir = await makeSessionDir();

    const lock = await acquireSessionRunLock({
      sessionDir,
      runId: 'run_001',
      pid: 123,
      command: 'headless run',
    });

    expect(lock).toMatchObject({ sessionDir, runId: 'run_001' });
    const raw = await readFile(join(sessionDir, 'run.lock'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      schemaVersion: 1,
      runId: 'run_001',
      pid: 123,
      createdAt: expect.any(String),
      command: 'headless run',
    });
  });

  it('rejects a second live lock with session.locked', async () => {
    const sessionDir = await makeSessionDir();
    const first = await acquireSessionRunLock({
      sessionDir,
      runId: 'run_001',
      pid: process.pid,
      command: 'headless run',
    });

    try {
      await expect(
        acquireSessionRunLock({
          sessionDir,
          runId: 'run_002',
          pid: process.pid,
          command: 'headless run',
        }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.locked',
      } satisfies Partial<KimiError>);
    } finally {
      await first.release();
    }
  });

  it('removes the lock on release', async () => {
    const sessionDir = await makeSessionDir();
    const lock = await acquireSessionRunLock({
      sessionDir,
      runId: 'run_001',
      pid: process.pid,
      command: 'headless run',
    });

    await lock.release();

    await expect(access(join(sessionDir, 'run.lock'))).rejects.toThrow();
  });

  it('removes a stale lock with a dead pid', async () => {
    const sessionDir = await makeSessionDir();
    await writeFile(
      join(sessionDir, 'run.lock'),
      `${JSON.stringify({
        schemaVersion: 1,
        runId: 'old_run',
        pid: 999_999_999,
        createdAt: '2026-06-05T00:00:00.000Z',
        command: 'headless run',
      })}\n`,
      'utf-8',
    );

    const lock = await acquireSessionRunLock({
      sessionDir,
      runId: 'run_001',
      pid: process.pid,
      command: 'headless run',
    });

    const raw = await readFile(join(sessionDir, 'run.lock'), 'utf-8');
    expect(JSON.parse(raw)).toMatchObject({ runId: 'run_001' });
    await lock.release();
  });

  it('removes a stale corrupt lock file', async () => {
    const sessionDir = await makeSessionDir();
    const lockPath = join(sessionDir, 'run.lock');
    await writeFile(lockPath, '{"schemaVersion":', 'utf-8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const lock = await acquireSessionRunLock({
      sessionDir,
      runId: 'run_001',
      pid: process.pid,
      command: 'headless run',
    });

    const raw = await readFile(lockPath, 'utf-8');
    expect(JSON.parse(raw)).toMatchObject({ runId: 'run_001' });
    await lock.release();
  });

  it('does not release another run lock', async () => {
    const sessionDir = await makeSessionDir();
    const lock = await acquireSessionRunLock({
      sessionDir,
      runId: 'run_001',
      pid: process.pid,
      command: 'headless run',
    });
    await writeFile(
      join(sessionDir, 'run.lock'),
      `${JSON.stringify({
        schemaVersion: 1,
        runId: 'run_002',
        pid: process.pid,
        createdAt: '2026-06-05T00:00:00.000Z',
        command: 'headless run',
      })}\n`,
      'utf-8',
    );

    await lock.release();

    const raw = await readFile(join(sessionDir, 'run.lock'), 'utf-8');
    expect(JSON.parse(raw)).toMatchObject({ runId: 'run_002' });
  });
});
