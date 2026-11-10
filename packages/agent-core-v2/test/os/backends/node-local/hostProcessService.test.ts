import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as nativeJoin } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
} from '#/os/interface/hostProcess';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

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

  it.skipIf(process.platform === 'win32')('throws a coded error when the command does not exist', async () => {
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

  it.skipIf(process.platform !== 'win32')('executes a batch script resolved from PATH', async () => {
    const svc = ix.get(IHostProcessService);
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      await writeFile(nativeJoin(dir, 'echo-args.cmd'), '@echo %*\r\n');
      const proc = await svc.spawn('echo-args', ['hello', 'a b'], { env: { PATH: dir } });
      const out = await collect(proc.stdout);
      expect(out.trim()).toBe('"hello" "a b"');
      expect(await proc.wait()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('HostProcessService on Windows', () => {
  let savedPlatform: string;
  let spawnedCommands: string[];
  let crossSpawnCalls: Array<{
    command: string;
    args: readonly string[];
    options: { cwd?: string; env?: Record<string, string> };
  }>;
  let crossSpawnError: (Error & { code: string }) | undefined;
  let taskkills: Array<{ kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }>;

  beforeEach(() => {
    savedPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    spawnedCommands = [];
    crossSpawnCalls = [];
    crossSpawnError = undefined;
    taskkills = [];
    vi.doMock('cross-spawn', () => ({
      default: (
        command: string,
        args: readonly string[],
        options: { cwd?: string; env?: Record<string, string> },
      ) => {
        crossSpawnCalls.push({ command, args, options });
        if (crossSpawnError !== undefined) throw crossSpawnError;
        const child = Object.assign(new EventEmitter(), {
          pid: 4242,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: vi.fn(() => true),
          unref: vi.fn(),
        });
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    }));
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      spawn: (command: string, args: readonly string[]) => {
        spawnedCommands.push([command, ...args].join(' '));
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
      },
    }));
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('cross-spawn');
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

  it('delegates spawning to cross-spawn with env and cwd forwarded', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('fake-tool', ['-y', 'some value'], {
        cwd: dir,
        env: { FOO: 'bar' },
      });
      expect(crossSpawnCalls).toHaveLength(1);
      const call = crossSpawnCalls[0]!;
      expect(call.command).toBe('fake-tool');
      expect(call.args).toEqual(['-y', 'some value']);
      expect(call.options.cwd).toBe(dir);
      expect(call.options.env?.['FOO']).toBe('bar');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses native spawn for commands with an explicit shell option', async () => {
    const { HostProcessService: WindowsHostProcessService } = await import(
      '#/os/backends/node-local/hostProcessService'
    );
    await new WindowsHostProcessService().spawn('fake-tool', [], { shell: true });
    expect(crossSpawnCalls).toEqual([]);
    expect(spawnedCommands).toEqual(['fake-tool']);
  });

  it('normalizes a synchronous spawn failure into HostProcessError', async () => {
    crossSpawnError = Object.assign(new Error('The operation is not permitted'), { code: 'EINVAL' });
    const { HostProcessService: WindowsHostProcessService } = await import(
      '#/os/backends/node-local/hostProcessService'
    );
    const { HostProcessError: WindowsHostProcessError } = await import('#/os/interface/hostProcess');
    await expect(new WindowsHostProcessService().spawn('fake-tool.cmd')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(WindowsHostProcessError);
      const error = err as HostProcessError;
      expect(error.code).toBe(HostProcessErrorCode.SpawnFailed);
      expect(error.details).toMatchObject({ command: 'fake-tool.cmd', errno: 'EINVAL' });
      return true;
    });
  });
});
