import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import crossSpawn from 'cross-spawn';

import { BufferedReadable } from '#/_base/execEnv/bufferedReadable';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
  type HostProcessOptions,
  type IHostProcess,
} from '#/os/interface/hostProcess';

const isWindows: boolean = process.platform === 'win32';
const TASKKILL_TIMEOUT_MS = 5_000;

export function resolveWindowsBatchCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): string | undefined {
  const lowerCommand = command.toLowerCase();
  if (lowerCommand.endsWith('.bat') || lowerCommand.endsWith('.cmd')) {
    return isFile(command) ? command : undefined;
  }
  if (command.includes('/') || command.includes('\\')) return undefined;
  const pathExt = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => stripQuotes(ext.trim()).toLowerCase())
    .filter((ext) => ext === '.bat' || ext === '.cmd');
  if (pathExt.length === 0) return undefined;
  const dirs = (env['PATH'] ?? '')
    .split(';')
    .map((dir) => stripQuotes(dir.trim()))
    .filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    for (const ext of pathExt) {
      const candidate = resolve(cwd, dir, `${command}${ext}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function stripQuotes(value: string): string {
  return value.replaceAll(/^"|"$/g, '');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function spawnProcess(
  command: string,
  args: readonly string[],
  spawnOptions: SpawnOptions,
  env: NodeJS.ProcessEnv,
  cwd: string,
): ChildProcess {
  if (!isWindows) return spawn(command, args as string[], spawnOptions);
  const batchCommand = resolveWindowsBatchCommand(command, env, cwd);
  if (batchCommand === undefined) return spawn(command, args as string[], spawnOptions);
  return crossSpawn(batchCommand, args as string[], spawnOptions);
}

function buildSpawnOptions(options: HostProcessOptions): SpawnOptions {
  const detached = options.detached ?? !isWindows;
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: buildEnv(options.env),
    stdio: options.mergeStderr ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    detached,
    windowsHide: options.windowsHide ?? true,
    timeout: options.timeout,
  };

  if (options.shell !== undefined) {
    spawnOptions.shell = options.shell;
  }

  return spawnOptions;
}

function buildEnv(overrides: Record<string, string> | undefined): Record<string, string> | undefined {
  if (overrides === undefined) {
    return undefined;
  }
  return { ...(process.env as Record<string, string>), ...overrides };
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn);
      reject(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

class HostProcess implements IHostProcess {
  declare readonly _serviceBrand: undefined;

  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private readonly _child: ChildProcess;
  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;
  private _disposed = false;

  constructor(child: ChildProcess, mergeStderr: boolean) {
    if (child.stdin === null || child.stdout === null) {
      throw new HostProcessError(
        HostProcessErrorCode.SpawnFailed,
        'Process must be created with stdin/stdout pipes.',
      );
    }
    if (!mergeStderr && child.stderr === null) {
      throw new HostProcessError(
        HostProcessErrorCode.SpawnFailed,
        'Process must be created with stderr pipe unless mergeStderr is set.',
      );
    }

    this._child = child;
    this.stdin = child.stdin;
    this.stdout = new BufferedReadable(child.stdout);
    this.stderr = mergeStderr
      ? this.stdout
      : new BufferedReadable(child.stderr as Readable);
    this.pid = child.pid ?? -1;

    this._exitPromise = new Promise<number>((resolve, reject) => {
      child.on('exit', (code: number | null) => {
        this._exitCode = code ?? -1;
        resolve(this._exitCode);
      });
      child.on('error', (error: Error) => {
        reject(error);
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  async wait(): Promise<number> {
    return this._exitPromise;
  }

  async kill(signal?: NodeJS.Signals): Promise<void> {
    if (this.pid <= 0) {
      return;
    }

    if (isWindows) {
      const taskkillArgs = ['/T', '/F', '/PID', String(this.pid)];
      const killer = spawn('taskkill', taskkillArgs, {
        stdio: 'ignore',
        windowsHide: true,
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const exited = await Promise.race([
        new Promise<true>((resolve) => {
          const done = (): void => {
            resolve(true);
          };
          killer.once('error', done);
          killer.once('close', done);
        }),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => {
            resolve(false);
          }, TASKKILL_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
      clearTimeout(timeout);
      if (!exited) {
        killer.unref();
        killer.kill();
      }
      return;
    }

    try {
      process.kill(-this.pid, signal ?? 'SIGTERM');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ESRCH') return;
      if (err.code === 'EPERM') {
        try {
          this._child.kill(signal ?? 'SIGTERM');
        } catch {
        }
        return;
      }
      throw new HostProcessError(
        HostProcessErrorCode.KillFailed,
        `Failed to kill process ${this.pid}: ${err.message}`,
        {
          details: { pid: this.pid, signal: signal ?? 'SIGTERM', errno: err.code },
          cause: error,
        },
      );
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stdin.destroy();
    this.stdout.destroy();
    if (this.stderr !== this.stdout) {
      this.stderr.destroy();
    }
  }
}

export class HostProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  async spawn(
    command: string,
    args: readonly string[] = [],
    options: HostProcessOptions = {},
  ): Promise<IHostProcess> {
    const spawnOptions = buildSpawnOptions(options);
    const child = spawnProcess(
      command,
      args,
      spawnOptions,
      buildEnv(options.env) ?? process.env,
      resolve(options.cwd ?? process.cwd()),
    );
    try {
      await waitForSpawn(child);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      throw new HostProcessError(
        HostProcessErrorCode.SpawnFailed,
        `Failed to spawn "${command}": ${err.message}`,
        {
          details: { command, args: [...args], cwd: options.cwd, errno: err.code },
          cause: error,
        },
      );
    }
    return new HostProcess(child, options.mergeStderr ?? false);
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostProcessService,
  HostProcessService,
  ScopeActivation.OnScopeCreated,
  'hostProcess',
);
