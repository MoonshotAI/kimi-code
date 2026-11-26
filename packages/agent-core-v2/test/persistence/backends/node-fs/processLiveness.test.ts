import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { processStampAlive } from '#/persistence/backends/node-fs/processLiveness';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const startTimeObservable = process.platform !== 'win32';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  vi.restoreAllMocks();
  vi.mocked(execFileSync).mockClear();
});

async function startLiveChild(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  await once(child, 'spawn');
  if (child.pid === undefined) throw new Error('child has no pid');
  return child.pid;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  if (child.pid === undefined) throw new Error('child has no pid');
  return child.pid;
}

describe('processStampAlive', () => {
  it('keeps an owner that recorded the lock after its process started', async () => {
    const pid = await startLiveChild();

    expect(processStampAlive({ pid, startedAt: Date.now() })).toBe(true);
    expect(processStampAlive({ pid: process.pid, startedAt: Date.now() })).toBe(true);
  });

  it('rejects an owner whose process has exited', async () => {
    const pid = await exitedPid();

    expect(processStampAlive({ pid, startedAt: Date.now() })).toBe(false);
  });

  it('rejects a live pid whose process started after the lock was recorded', async () => {
    const startedAt = Date.now() - 60_000;
    const pid = await startLiveChild();

    expect(processStampAlive({ pid, startedAt })).toBe(!startTimeObservable);
  });

  it('rejects a lock recorded before the current boot even when the pid is alive', () => {
    const beforeBoot = Date.now() - os.uptime() * 1000 - 60_000;

    expect(processStampAlive({ pid: process.pid, startedAt: beforeBoot })).toBe(false);
  });

  it('rejects pids and timestamps that cannot name a process', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(processStampAlive({ pid, startedAt: Date.now() })).toBe(false);
    }
    expect(processStampAlive({ pid: process.pid, startedAt: Number.NaN })).toBe(false);
  });

  it('rejects a zombie owner', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('Z\n');

    expect(processStampAlive({ pid: process.pid, startedAt: Date.now() })).toBe(!startTimeObservable);
  });

  it('reads process ages that span days', () => {
    vi.spyOn(os, 'uptime').mockReturnValue(30 * 86_400);
    const age = (2 * 86_400 + 3 * 3_600 + 4 * 60 + 5) * 1000;
    vi.mocked(execFileSync)
      .mockReturnValueOnce('Ss   2-03:04:05\n')
      .mockReturnValueOnce('Ss   2-03:04:05\n');

    expect(processStampAlive({ pid: process.pid, startedAt: Date.now() - age + 1_000 })).toBe(true);
    expect(processStampAlive({ pid: process.pid, startedAt: Date.now() - age - 60_000 })).toBe(
      !startTimeObservable,
    );
  });

  it('treats an owner on another host as alive', () => {
    expect(processStampAlive({ pid: 0, hostname: 'another-host', startedAt: 0 }, 'this-host')).toBe(true);
  });

  it('keeps the owner when the process table cannot be read', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('ps unavailable');
    });

    expect(processStampAlive({ pid: process.pid, startedAt: Date.now() })).toBe(true);
  });
});
