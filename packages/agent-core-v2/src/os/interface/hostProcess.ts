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

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface HostProcessOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly shell?: boolean | string;
  readonly detached?: boolean;
  readonly windowsHide?: boolean;
  readonly mergeStderr?: boolean;
  readonly timeout?: number;
}

export interface IHostProcess {
  readonly _serviceBrand: undefined;

  readonly pid: number;
  readonly exitCode: number | null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  wait(): Promise<number>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  dispose(): void;
}

export interface IHostProcessService {
  readonly _serviceBrand: undefined;

  spawn(
    command: string,
    args?: readonly string[],
    options?: HostProcessOptions,
  ): Promise<IHostProcess>;
}

export const IHostProcessService: ServiceIdentifier<IHostProcessService> =
  createDecorator<IHostProcessService>('hostProcessService');

export const OsProcessErrors = {
  codes: {
    OS_PROCESS_SPAWN_FAILED: 'os.process.spawn_failed',
    OS_PROCESS_KILL_FAILED: 'os.process.kill_failed',
  },
  info: {
    'os.process.spawn_failed': {
      title: 'Failed to spawn process',
      retryable: false,
      public: true,
      action: 'Check that the command exists and is executable.',
    },
    'os.process.kill_failed': {
      title: 'Failed to kill process',
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(OsProcessErrors);

export const HostProcessErrorCode = {
  SpawnFailed: OsProcessErrors.codes.OS_PROCESS_SPAWN_FAILED,
  KillFailed: OsProcessErrors.codes.OS_PROCESS_KILL_FAILED,
} as const;

export type HostProcessErrorCode = (typeof HostProcessErrorCode)[keyof typeof HostProcessErrorCode];

export class HostProcessError extends Error2 {
  constructor(code: HostProcessErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'HostProcessError';
  }
}
