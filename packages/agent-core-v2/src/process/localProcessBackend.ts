/**
 * `process` domain (L1) — local `IProcessBackend` implementation.
 *
 * Spawns real child processes on the host through `node:child_process`.
 * Registered as the default `IProcessBackend` at Session scope; remote
 * backends override it via the scope registry.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { type IProcess, IProcessBackend } from './process';

class LocalProcess implements IProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  constructor(private readonly child: ChildProcess) {
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error('LocalProcess: child must be spawned with piped stdio.');
    }
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.pid = child.pid ?? -1;
  }

  wait(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.child.once('exit', (code) => resolve(code ?? -1));
      this.child.once('error', reject);
    });
  }

  kill(signal?: NodeJS.Signals): Promise<void> {
    this.child.kill(signal);
    return Promise.resolve();
  }
}

export class LocalProcessBackend implements IProcessBackend {
  declare readonly _serviceBrand: undefined;

  spawn(
    args: readonly string[],
    options: { readonly cwd: string; readonly env?: Record<string, string> },
  ): Promise<IProcess> {
    const [command, ...rest] = args;
    if (command === undefined) {
      return Promise.reject(new Error('LocalProcessBackend.spawn: command is required.'));
    }
    const child = spawn(command, rest, {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return Promise.resolve(new LocalProcess(child));
  }
}

registerScopedService(
  LifecycleScope.Session,
  IProcessBackend,
  LocalProcessBackend,
  InstantiationType.Delayed,
  'process',
);
