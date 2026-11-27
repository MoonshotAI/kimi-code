import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireRemoteControlLock,
  inspectRemoteControlLock,
  remoteControlLockPath,
  RemoteControlAlreadyRunningError,
  type RemoteControlLock,
} from '../src/lock';

const fsControl = vi.hoisted(() => {
  type FsStep = 'read' | 'write' | 'unlink' | 'link';
  interface Armed {
    readonly step: FsStep;
    readonly matches: (path: string) => boolean;
  }
  interface ArmedPause extends Armed {
    readonly reached: () => void;
    readonly resume: Promise<void>;
  }
  interface ArmedFailure extends Armed {
    readonly code: string;
  }
  const pauses: ArmedPause[] = [];
  const failures: ArmedFailure[] = [];
  const take = <T extends Armed>(armed: T[], step: FsStep, target: unknown): T | undefined => {
    if (typeof target !== 'string') return undefined;
    const index = armed.findIndex((entry) => entry.step === step && entry.matches(target));
    return index === -1 ? undefined : armed.splice(index, 1)[0];
  };
  return {
    pauseAt(step: FsStep, matches: (path: string) => boolean) {
      let reached!: () => void;
      let resume!: () => void;
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const resumePromise = new Promise<void>((resolve) => {
        resume = resolve;
      });
      pauses.push({ step, matches, reached, resume: resumePromise });
      return { reached: reachedPromise, resume };
    },
    failAt(step: FsStep, matches: (path: string) => boolean, code: string): void {
      failures.push({ step, matches, code });
    },
    async pause(step: FsStep, target: unknown): Promise<void> {
      const pause = take(pauses, step, target);
      if (pause === undefined) return;
      pause.reached();
      await pause.resume;
    },
    throwIfFailing(step: FsStep, target: unknown): void {
      const failure = take(failures, step, target);
      if (failure === undefined) return;
      throw Object.assign(new Error(`${failure.code}: injected ${step} failure`), {
        code: failure.code,
      });
    },
    pendingFailures(): number {
      return failures.length;
    },
    reset(): void {
      pauses.length = 0;
      failures.length = 0;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      fsControl.throwIfFailing('read', args[0]);
      const content = await actual.readFile(...args);
      await fsControl.pause('read', args[0]);
      return content;
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await fsControl.pause('write', args[0]);
      return actual.writeFile(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = (async (...writeArgs: Parameters<typeof writeFile>) => {
        await fsControl.pause('write', args[0]);
        return writeFile(...writeArgs);
      }) as typeof handle.writeFile;
      return handle;
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      await fsControl.pause('unlink', args[0]);
      return actual.unlink(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      fsControl.throwIfFailing('link', args[1]);
      return actual.link(...args);
    },
  };
});

type AcquireOutcome =
  | { readonly deviceId: string; readonly lock: RemoteControlLock }
  | { readonly deviceId: string; readonly error: unknown };

const homes: string[] = [];

afterEach(() => {
  fsControl.reset();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function lockHome(): { readonly homeDir: string; readonly lockPath: string } {
  const homeDir = mkdtempSync(join(tmpdir(), 'kimi-rc-lock-'));
  homes.push(homeDir);
  const lockPath = remoteControlLockPath(homeDir);
  mkdirSync(dirname(lockPath), { recursive: true });
  return { homeDir, lockPath };
}

function details(deviceId: string) {
  return {
    localOrigin: 'http://127.0.0.1:58627',
    deviceId,
    url: `https://code-rc.kimi.com/devices/${deviceId}/`,
  };
}

async function attempt(homeDir: string, deviceId: string): Promise<AcquireOutcome> {
  try {
    return { deviceId, lock: await acquireRemoteControlLock(homeDir, details(deviceId)) };
  } catch (error) {
    return { deviceId, error };
  }
}

async function deadHolderRecord(nonce: string): Promise<string> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return JSON.stringify({
    pid: child.pid,
    nonce,
    local_origin: 'http://127.0.0.1:1',
    device_id: 'dead-device',
    url: 'https://code-rc.kimi.com/devices/dead-device/',
    started_at: 0,
  });
}

function liveHolderRecord(): string {
  return JSON.stringify({
    pid: process.pid,
    nonce: 'live-holder',
    local_origin: 'http://127.0.0.1:58628',
    device_id: 'live-device',
    url: 'https://code-rc.kimi.com/devices/live-device/',
    started_at: Date.now(),
  });
}

async function pausedBefore(reached: Promise<void>, pending: Promise<unknown>): Promise<void> {
  await Promise.race([
    reached,
    pending.then(() => {
      throw new Error('the operation finished without reaching the paused filesystem step');
    }),
  ]);
}

function diskDeviceId(lockPath: string): string {
  return (JSON.parse(readFileSync(lockPath, 'utf8')) as { device_id: string }).device_id;
}

async function expectSingleHolder(lockPath: string, outcomes: readonly AcquireOutcome[]): Promise<void> {
  const holders = outcomes.filter((outcome) => 'lock' in outcome);
  expect(holders.map((holder) => holder.deviceId)).toHaveLength(1);
  const winner = holders[0] as Extract<AcquireOutcome, { lock: RemoteControlLock }>;
  for (const outcome of outcomes) {
    if ('lock' in outcome) continue;
    expect(outcome.error).toBeInstanceOf(RemoteControlAlreadyRunningError);
    expect((outcome.error as RemoteControlAlreadyRunningError).holder.deviceId).toBe(winner.deviceId);
  }
  expect(diskDeviceId(lockPath)).toBe(winner.deviceId);
  expect(readdirSync(dirname(lockPath))).toEqual(['rc.json']);
  await winner.lock.release();
  expect(existsSync(lockPath)).toBe(false);
}

describe('Remote Control machine lock', () => {
  it('lets only one of two acquirers hold the lock while the first is still writing it', async () => {
    const { homeDir, lockPath } = lockHome();
    const pause = fsControl.pauseAt('write', (path) => dirname(path) === dirname(lockPath));
    const first = attempt(homeDir, 'first-device');
    await pausedBefore(pause.reached, first);

    const second = await attempt(homeDir, 'second-device');
    pause.resume();

    await expectSingleHolder(lockPath, [await first, second]);
  });

  it('lets only one of two acquirers take over the same dead holder', async () => {
    const { homeDir, lockPath } = lockHome();
    writeFileSync(lockPath, await deadHolderRecord('dead-holder'));
    const pause = fsControl.pauseAt('unlink', (path) => path === lockPath);
    const first = attempt(homeDir, 'first-device');
    await pausedBefore(pause.reached, first);

    const second = await attempt(homeDir, 'second-device');
    pause.resume();

    await expectSingleHolder(lockPath, [await first, second]);
  });

  it('keeps a lock published after the dead holder it judged was already removed', async () => {
    const { homeDir, lockPath } = lockHome();
    writeFileSync(lockPath, await deadHolderRecord('dead-holder'));
    const judged = fsControl.pauseAt('read', (path) => path === lockPath);
    const first = attempt(homeDir, 'first-device');
    await pausedBefore(judged.reached, first);
    rmSync(lockPath);
    const removing = fsControl.pauseAt('unlink', (path) => path === lockPath);
    judged.resume();
    await Promise.race([removing.reached, first]);

    const second = await attempt(homeDir, 'second-device');
    removing.resume();

    await expectSingleHolder(lockPath, [await first, second]);
  });

  it('lets only one of two acquirers take over after an earlier takeover died midway', async () => {
    const { homeDir, lockPath } = lockHome();
    writeFileSync(lockPath, await deadHolderRecord('dead-holder'));
    const crashed = fsControl.pauseAt('unlink', (path) => path === lockPath);
    void attempt(homeDir, 'crashed-device');
    await crashed.reached;
    const markers = readdirSync(dirname(lockPath)).filter((name) => name.startsWith('rc.json.reclaim'));
    expect(markers).toHaveLength(1);
    writeFileSync(join(dirname(lockPath), markers[0] as string), await deadHolderRecord('dead-reclaimer'));

    const judging = fsControl.pauseAt('read', (path) => path.startsWith(`${lockPath}.reclaim`));
    const removing = fsControl.pauseAt('unlink', (path) => path === lockPath);
    const first = attempt(homeDir, 'first-device');
    await pausedBefore(judging.reached, first);
    const second = attempt(homeDir, 'second-device');
    await pausedBefore(removing.reached, second);
    judging.resume();
    const firstOutcome = await first;
    removing.resume();

    await expectSingleHolder(lockPath, [firstOutcome, await second]);
  });

  it('keeps its claim when its own takeover fails midway and still lets this process retry', async () => {
    const { homeDir, lockPath } = lockHome();
    writeFileSync(lockPath, await deadHolderRecord('dead-holder'));
    let lockReads = 0;
    fsControl.failAt('read', (path) => path === lockPath && ++lockReads === 2, 'EBUSY');

    const failed = await attempt(homeDir, 'failed-device');

    expect('error' in failed && (failed.error as NodeJS.ErrnoException).code).toBe('EBUSY');
    expect(readdirSync(dirname(lockPath)).filter((name) => name.startsWith('rc.json.reclaim'))).toHaveLength(1);
    const retried = await attempt(homeDir, 'retry-device');
    await expectSingleHolder(lockPath, [retried]);
  });

  it('keeps a lock taken over while an inspection was judging the previous holder dead', async () => {
    const { homeDir, lockPath } = lockHome();
    writeFileSync(lockPath, await deadHolderRecord('dead-holder'));
    const pause = fsControl.pauseAt('read', (path) => path === lockPath);
    const inspecting = inspectRemoteControlLock(homeDir);
    await pausedBefore(pause.reached, inspecting);

    const holder = await acquireRemoteControlLock(homeDir, details('holder-device'));
    pause.resume();

    await expect(inspecting).resolves.toBeUndefined();
    const late = await attempt(homeDir, 'late-device');
    await expectSingleHolder(lockPath, [{ deviceId: 'holder-device', lock: holder }, late]);
  });

  it('keeps a lock it cannot read and reports the read failure', async () => {
    const { homeDir, lockPath } = lockHome();
    const live = liveHolderRecord();
    writeFileSync(lockPath, live);
    fsControl.failAt('read', (path) => path === lockPath, 'EMFILE');

    const outcome = await attempt(homeDir, 'new-device');

    expect('error' in outcome && (outcome.error as NodeJS.ErrnoException).code).toBe('EMFILE');
    expect(readFileSync(lockPath, 'utf8')).toBe(live);
  });

  it.each([
    ['empty', ''],
    ['truncated', '{"pid":'],
  ])('takes over a lock file that is %s', async (_kind, content) => {
    const { homeDir, lockPath } = lockHome();
    writeFileSync(lockPath, content);

    const outcome = await attempt(homeDir, 'new-device');

    await expectSingleHolder(lockPath, [outcome]);
  });

  it('still takes the lock where the filesystem refuses hard links', async () => {
    const { homeDir, lockPath } = lockHome();
    fsControl.failAt('link', (path) => path === lockPath, 'EPERM');

    const outcome = await attempt(homeDir, 'new-device');

    expect(fsControl.pendingFailures()).toBe(0);
    await expectSingleHolder(lockPath, [outcome]);
  });
});
