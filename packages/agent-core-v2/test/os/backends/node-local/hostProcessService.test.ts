import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join as nativeJoin, resolve as nativeResolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { join } from 'pathe';

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
  let taskkills: Array<{ kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }>;
  const expectedComspec = process.env['COMSPEC'] ?? 'cmd.exe';

  beforeEach(() => {
    savedPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    spawnedCommands = [];
    taskkills = [];
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

  it('wraps a bare batch script command into cmd.exe', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      await writeFile(nativeJoin(dir, 'fake-tool.cmd'), '@echo off\r\n');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('fake-tool', ['-y', 'some value'], {
        env: { PATH: dir, ComSpec: 'cmd.exe' },
      });
      const binPath = nativeJoin(dir, 'fake-tool.cmd');
      expect(spawnedCommands).toEqual([`${expectedComspec} /d /s /c "${binPath} ^"-y^" ^"some^ value^""`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wraps a batch script command that carries its extension', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      const binPath = nativeJoin(dir, 'fake-tool.cmd');
      await writeFile(binPath, '@echo off\r\n');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('fake-tool.cmd', ['--flag'], {
        env: { PATH: dir, ComSpec: 'cmd.exe' },
      });
      expect(spawnedCommands).toEqual([`${expectedComspec} /d /s /c "${binPath} ^"--flag^""`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wraps a batch script addressed by path', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      const binPath = nativeJoin(dir, 'fake-tool.cmd');
      await writeFile(binPath, '@echo off\r\n');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn(binPath, [], { env: { ComSpec: 'cmd.exe' } });
      expect(spawnedCommands).toEqual([`${expectedComspec} /d /s /c "${binPath}"`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves an executable winner of PATHEXT resolution untouched', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      await writeFile(nativeJoin(dir, 'dual-tool.exe'), '');
      await writeFile(nativeJoin(dir, 'dual-tool.cmd'), '@echo off\r\n');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('dual-tool', [], {
        env: { PATH: dir, ComSpec: 'cmd.exe' },
      });
      expect(spawnedCommands).toEqual(['dual-tool']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves an unknown command untouched', async () => {
    const { HostProcessService: WindowsHostProcessService } = await import(
      '#/os/backends/node-local/hostProcessService'
    );
    await new WindowsHostProcessService().spawn('definitely-missing-xyz', [], {
      env: { ComSpec: 'cmd.exe' },
    });
    expect(spawnedCommands).toEqual(['definitely-missing-xyz']);
  });

  it('leaves a command with an explicit shell option untouched', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      await writeFile(nativeJoin(dir, 'fake-tool.cmd'), '@echo off\r\n');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('fake-tool', [], {
        shell: true,
        env: { PATH: dir, ComSpec: 'cmd.exe' },
      });
      expect(spawnedCommands).toEqual(['fake-tool']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('escapes cmd.exe metacharacters in batch arguments', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      const binPath = nativeJoin(dir, 'fake-tool.cmd');
      await writeFile(binPath, '@echo off\r\n');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('fake-tool', ['foo&echo PWNED'], {
        env: { PATH: dir, ComSpec: 'cmd.exe' },
      });
      expect(spawnedCommands).toEqual([`${expectedComspec} /d /s /c "${binPath} ^"foo^&echo^ PWNED^""`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves a relative batch path against the spawn cwd', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      const binPath = nativeJoin(dir, 'server.cmd');
      await writeFile(binPath, '@echo off\r\n');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('./server.cmd', [], {
        cwd: dir,
        env: { ComSpec: 'cmd.exe' },
      });
      expect(spawnedCommands).toEqual([`${expectedComspec} /d /s /c "${nativeResolve(dir, 'server.cmd')}"`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('probes an explicit batch extension even when PATHEXT omits it', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      const binPath = nativeJoin(dir, 'fake-tool.cmd');
      await writeFile(binPath, '@echo off\r\n');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('fake-tool.cmd', [], {
        env: { PATH: dir, ComSpec: 'cmd.exe', PATHEXT: '.EXE;.COM' },
      });
      expect(spawnedCommands).toEqual([`${expectedComspec} /d /s /c "${binPath}"`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prefers an exe in a later PATH directory over a batch script in an earlier one', async () => {
    const shimDir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-shim-'));
    const binDir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-bin-'));
    try {
      await writeFile(nativeJoin(shimDir, 'dual-tool.cmd'), '@echo off\r\n');
      await writeFile(nativeJoin(binDir, 'dual-tool.exe'), '');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('dual-tool', [], {
        env: { PATH: shimDir + delimiter + binDir, ComSpec: 'cmd.exe' },
      });
      expect(spawnedCommands).toEqual(['dual-tool']);
    } finally {
      await rm(shimDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('wraps a bare batch command located in the spawn cwd', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      const binPath = nativeJoin(dir, 'fake-tool.cmd');
      await writeFile(binPath, '@echo off\r\n');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('fake-tool', [], {
        cwd: dir,
        env: { PATH: '', ComSpec: 'cmd.exe' },
      });
      expect(spawnedCommands).toEqual([`${expectedComspec} /d /s /c "${binPath}"`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('roots relative PATH entries at the spawn cwd for the native probe', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cwd-'));
    const shimDir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-shim-'));
    try {
      await mkdir(nativeJoin(dir, 'bin'), { recursive: true });
      await writeFile(nativeJoin(dir, 'bin', 'tool.exe'), '');
      await writeFile(nativeJoin(shimDir, 'tool.cmd'), '@echo off\r\n');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('tool', [], {
        cwd: dir,
        env: { PATH: 'bin' + delimiter + shimDir, ComSpec: 'cmd.exe' },
      });
      expect(spawnedCommands).toEqual(['tool']);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(shimDir, { recursive: true, force: true });
    }
  });

  it('rejects line breaks in batch arguments', async () => {
    const dir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    try {
      await writeFile(nativeJoin(dir, 'fake-tool.cmd'), '@echo off\r\n');
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await expect(
        new WindowsHostProcessService().spawn('fake-tool', ['innocent\r\ncalc.exe'], {
          env: { PATH: dir, ComSpec: 'cmd.exe' },
        }),
      ).rejects.toThrow(/line breaks/);
      expect(spawnedCommands).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the lexicographically smallest key among case-insensitive PATH matches', async () => {
    const exeDir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-exe-'));
    const cmdDir = await mkdtemp(nativeJoin(tmpdir(), 'kimi-spawn-cmd-'));
    const savedEnv = process.env;
    try {
      await writeFile(nativeJoin(exeDir, 'fake-tool.exe'), '');
      await writeFile(nativeJoin(cmdDir, 'fake-tool.cmd'), '@echo off\r\n');
      process.env = { ...savedEnv, PATH: exeDir };
      const { HostProcessService: WindowsHostProcessService } = await import(
        '#/os/backends/node-local/hostProcessService'
      );
      await new WindowsHostProcessService().spawn('fake-tool', [], {
        env: { Path: cmdDir, ComSpec: 'cmd.exe' },
      });
      expect(spawnedCommands).toEqual(['fake-tool']);
    } finally {
      process.env = savedEnv;
      await rm(exeDir, { recursive: true, force: true });
      await rm(cmdDir, { recursive: true, force: true });
    }
  });
});
