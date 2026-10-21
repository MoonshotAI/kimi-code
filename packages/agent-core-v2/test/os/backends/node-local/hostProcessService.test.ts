import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
} from '#/os/interface/hostProcess';
import { HostProcessService, resolveWindowsBatchCommand } from '#/os/backends/node-local/hostProcessService';

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('HostProcessService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('spawns a process and captures stdout + exit code', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write("ok")']);
    const out = await collect(proc.stdout);
    expect(out).toBe('ok');
    expect(await proc.wait()).toBe(0);
    expect(proc.exitCode).toBe(0);
  });

  it('passes env overrides to the child', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write(process.env.FOO ?? "")'], {
      env: { FOO: 'bar' },
    });
    const out = await collect(proc.stdout);
    expect(out).toBe('bar');
    expect(await proc.wait()).toBe(0);
  });

  it('throws a coded error when the command does not exist', async () => {
    const svc = ix.get(IHostProcessService);
    await expect(svc.spawn('definitely-not-a-real-command-42')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(HostProcessError);
      const error = err as HostProcessError;
      expect(error.code).toBe(HostProcessErrorCode.SpawnFailed);
      expect(error.code).toBe('os.process.spawn_failed');
      expect(error.details).toMatchObject({
        command: 'definitely-not-a-real-command-42',
        errno: 'ENOENT',
      });
      expect(error.cause).toBeInstanceOf(Error);
      return true;
    });
  });

  it('terminates a running process with kill()', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'setTimeout(() => {}, 30000)']);
    expect(proc.pid).toBeGreaterThan(0);
    await proc.kill('SIGTERM');
    const code = await proc.wait();
    expect(code).not.toBe(0);
  });

  it('terminates a process that outlives its timeout', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 200 });
    const code = await proc.wait();
    expect(code).not.toBe(0);
  });
});

describe('HostProcessService on Windows', () => {
  let savedPlatform: string;
  let spawnedCommands: string[];
  let taskkills: Array<{ kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }>;

  const fakeChild = (command: string) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    if (command === 'taskkill') taskkills.push(child);
    else queueMicrotask(() => child.emit('spawn'));
    return child;
  };

  beforeEach(() => {
    savedPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    spawnedCommands = [];
    taskkills = [];
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      spawn: (command: string, args: readonly string[]) => {
        spawnedCommands.push([command, ...args].join(' '));
        return fakeChild(command);
      },
    }));
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: savedPlatform });
  });

  it('stops waiting for a taskkill that never exits and terminates it', async () => {
    const { HostProcessService: WindowsHostProcessService } = await import(
      '#/os/backends/node-local/hostProcessService'
    );
    const proc = await new WindowsHostProcessService().spawn('node', ['-e', 'setTimeout(() => {}, 30000)']);
    let killed = false;
    const kill = proc.kill('SIGTERM').then(() => {
      killed = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(spawnedCommands).toContain('taskkill /T /F /PID 4242');
    expect(killed).toBe(true);
    expect(taskkills).toHaveLength(1);
    expect(taskkills[0]?.kill).toHaveBeenCalled();
    expect(taskkills[0]?.unref).toHaveBeenCalled();
    await kill;
  });
});

describe('resolveWindowsBatchCommand', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-host-process-'));
    await writeFile(join(dir, 'kimi-probe.cmd'), '@echo off\r\necho ok\r\n');
    await writeFile(join(dir, 'kimi-probe.bat'), '@echo off\r\necho ok\r\n');
    await mkdir(join(dir, 'bin'), { recursive: true });
    await writeFile(join(dir, 'bin', 'kimi-probe.cmd'), '@echo off\r\necho ok\r\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const env = (): NodeJS.ProcessEnv => ({ PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' });

  it('resolves a bare command to the batch shim on PATH, in PATHEXT order', () => {
    expect(resolveWindowsBatchCommand('kimi-probe', env())).toBe(join(dir, 'kimi-probe.bat'));
  });

  it('resolves a command that only exists as a .bat shim', () => {
    const onlyBat = { PATH: dir, PATHEXT: '.BAT' };
    expect(resolveWindowsBatchCommand('kimi-probe', onlyBat)).toBe(join(dir, 'kimi-probe.bat'));
  });

  it('keeps an explicit batch path', () => {
    const shim = join(dir, 'kimi-probe.cmd');
    expect(resolveWindowsBatchCommand(shim, env())).toBe(shim);
  });

  it('returns undefined when no batch shim matches', () => {
    expect(resolveWindowsBatchCommand('kimi-missing', env())).toBeUndefined();
  });

  it('returns undefined for a non-batch command', () => {
    expect(resolveWindowsBatchCommand('git', env())).toBeUndefined();
  });

  it('returns undefined for an explicit non-batch path', () => {
    expect(resolveWindowsBatchCommand(join(dir, 'kimi-probe'), env())).toBeUndefined();
  });

  it('returns undefined when PATH does not contain the shim', () => {
    expect(resolveWindowsBatchCommand('kimi-probe', { PATH: '', PATHEXT: '.CMD' })).toBeUndefined();
  });

  it('returns undefined when PATHEXT has no batch extension', () => {
    expect(resolveWindowsBatchCommand('kimi-probe', { PATH: dir, PATHEXT: '.COM;.EXE' })).toBeUndefined();
  });

  it('reads PATH and PATHEXT case-insensitively', () => {
    expect(resolveWindowsBatchCommand('kimi-probe', { Path: dir, PathExt: '.CMD' })).toBe(
      join(dir, 'kimi-probe.cmd'),
    );
  });

  it('keeps a later executable ahead of an earlier batch shim', async () => {
    const other = join(dir, 'other');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'kimi-probe.cmd'), '@echo off\r\necho ok\r\n');
    await writeFile(join(dir, 'kimi-probe.exe'), 'binary');
    expect(
      resolveWindowsBatchCommand('kimi-probe', { PATH: `${dir};${other}`, PATHEXT: '.EXE;.CMD' }),
    ).toBeUndefined();
  });

  it('falls through to a batch shim when no earlier candidate exists', async () => {
    const other = join(dir, 'other');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'kimi-later.cmd'), '@echo off\r\necho ok\r\n');
    expect(
      resolveWindowsBatchCommand('kimi-later', { PATH: `${dir};${other}`, PATHEXT: '.EXE;.CMD' }),
    ).toBe(join(other, 'kimi-later.cmd'));
  });

  it('resolves through a quoted PATH entry', () => {
    expect(resolveWindowsBatchCommand('kimi-probe', { PATH: `"${dir}"`, PATHEXT: '.CMD' })).toBe(
      join(dir, 'kimi-probe.cmd'),
    );
  });

  it('resolves a relative PATH entry against the spawn cwd', () => {
    const nested = join(dir, 'bin');
    expect(
      resolveWindowsBatchCommand('kimi-probe', { PATH: 'bin', PATHEXT: '.CMD' }, dir),
    ).toBe(join(nested, 'kimi-probe.cmd'));
  });

  it('returns undefined for a batch path that does not exist', () => {
    expect(resolveWindowsBatchCommand(join(dir, 'missing.cmd'), env())).toBeUndefined();
  });
});

describe('HostProcessService on a Windows host', () => {
  it.skipIf(process.platform !== 'win32')('runs a batch shim command through PATHEXT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-host-process-'));
    const shim = join(dir, 'kimi-probe.cmd');
    await writeFile(shim, '@echo off\r\necho ok\r\n');
    try {
      const svc = new HostProcessService();
      const proc = await svc.spawn(shim, []);
      const out = await collect(proc.stdout);
      expect(out.trim()).toBe('ok');
      expect(await proc.wait()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('runs a bare batch shim command found on PATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-host-process-'));
    await writeFile(join(dir, 'kimi-probe.cmd'), '@echo off\r\necho ok\r\n');
    try {
      const svc = new HostProcessService();
      const proc = await svc.spawn('kimi-probe', [], { env: { Path: dir, PathExt: '.CMD' } });
      const out = await collect(proc.stdout);
      expect(out.trim()).toBe('ok');
      expect(await proc.wait()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
