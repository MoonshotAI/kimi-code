/**
 * `hostProcess` domain (L1) — the OS process-spawning contract.
 *
 * Defines `IHostProcessService`, the App-scope primitive used by any domain that
 * needs to spawn a child process on the host, plus the `IHostProcess` handle it
 * returns. The contract is deliberately close to Python `subprocess.Popen` /
 * `os.spawn*`: a single `spawn()` call returns a handle exposing stdin/stdout/
 * stderr, the pid, the exit code, and lifecycle methods. Bound at App scope;
 * backends in `os/backends/node-local` provide the Node implementation.
 */

import type { Readable, Writable } from 'node:stream';

import { KimiError, type ErrorCode } from '#/_base/errors';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface HostProcessOptions {
  /** Working directory for the child. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Complete env bag for the child. When omitted the child inherits `process.env`. */
  readonly env?: Record<string, string>;
  /**
   * If `true`, the command is run through the system shell. If a string, it is
   * used as the shell path. Mirrors Python `subprocess.run(..., shell=True)`.
   */
  readonly shell?: boolean | string;
  /**
   * Whether the child becomes a process-group leader. Default is `true` on
   * POSIX and `false` on Windows so that `kill()` can signal the whole tree.
   */
  readonly detached?: boolean;
  /** Hide the child window on Windows. Default `true`. */
  readonly windowsHide?: boolean;
  /** Redirect stderr into stdout (the child still gets a merged stream). */
  readonly mergeStderr?: boolean;
  /** Optional timeout in milliseconds for `wait()`. */
  readonly timeout?: number;
}

export interface IHostProcess {
  readonly _serviceBrand: undefined;

  readonly pid: number;
  readonly exitCode: number | null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Wait for the process to exit and return its exit code. */
  wait(): Promise<number>;
  /** Kill the process tree (not just the direct child) with the given signal. */
  kill(signal?: NodeJS.Signals): Promise<void>;
  /** Release stdio streams. Does not kill the process. */
  dispose(): void;
}

export interface IHostProcessService {
  readonly _serviceBrand: undefined;

  /**
   * Spawn a child process on the host. Resolves once the child has successfully
   * started (or rejects with a coded error if spawn fails with ENOENT / EACCES
   * / etc.).
   */
  spawn(
    command: string,
    args?: readonly string[],
    options?: HostProcessOptions,
  ): Promise<IHostProcess>;
}

export const IHostProcessService: ServiceIdentifier<IHostProcessService> =
  createDecorator<IHostProcessService>('hostProcessService');

export const HostProcessErrorCode = {
  SpawnFailed: 'process.spawn_failed' as ErrorCode,
} as const;

export class HostProcessError extends KimiError {
  constructor(code: (typeof HostProcessErrorCode)[keyof typeof HostProcessErrorCode], message: string) {
    super(code, message);
    this.name = 'HostProcessError';
  }
}
