/**
 * `process` domain (L1) — the Agent's process runner and its pluggable backend.
 *
 * Defines the `IProcessRunner` that business code injects to spawn processes
 * inside the Agent's execution environment, the `IProcess` handle it returns,
 * and the internal `IProcessBackend` provider that hides the
 * local/ssh/container split. Session-scoped. Business code depends on
 * `IProcessRunner` only; the backend is wired through the scope registry.
 */

import type { Readable, Writable } from 'node:stream';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;
  wait(): Promise<number>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export interface ProcessExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

export interface IProcessRunner {
  readonly _serviceBrand: undefined;

  exec(args: readonly string[], options?: ProcessExecOptions): Promise<IProcess>;
}

export const IProcessRunner: ServiceIdentifier<IProcessRunner> =
  createDecorator<IProcessRunner>('processRunner');

export interface IProcessBackend {
  readonly _serviceBrand: undefined;

  spawn(
    args: readonly string[],
    options: { readonly cwd: string; readonly env?: Record<string, string> },
  ): Promise<IProcess>;
}

export const IProcessBackend: ServiceIdentifier<IProcessBackend> =
  createDecorator<IProcessBackend>('processBackend');
