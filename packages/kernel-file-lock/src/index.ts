import { closeSync, fstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

export interface KernelFileLockBinding {
  flockSync(fd: number, flags: 'exnb' | 'un'): number;
}

export type KernelFileLockBindingLoader = () => KernelFileLockBinding | undefined;

export interface KernelFileLockAcquireOptions {
  readonly timeoutMs: number;
  readonly retryIntervalMs?: number;
}

export interface KernelFileLockHandle {
  readonly path: string;
  readonly held: boolean;
  checkHeld(): boolean;
  release(): void;
}

const DEFAULT_RETRY_INTERVAL_MS = 50;
const bindingLoaderKey = Symbol.for('@moonshot-ai/kernel-file-lock/binding-loader');
const nodeRequire = createRequire(import.meta.url);

type GlobalWithBindingLoader = typeof globalThis & {
  [bindingLoaderKey]?: KernelFileLockBindingLoader;
};

let binding: KernelFileLockBinding | undefined;

function defaultBindingLoader(): KernelFileLockBinding {
  return nodeRequire('fs-ext-extra-prebuilt') as KernelFileLockBinding;
}

function getBinding(): KernelFileLockBinding {
  if (binding !== undefined) return binding;
  const override = (globalThis as GlobalWithBindingLoader)[bindingLoaderKey];
  binding = override?.() ?? defaultBindingLoader();
  return binding;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EACCES' || code === 'EAGAIN' || code === 'EWOULDBLOCK';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class KernelFileLockHandleImpl implements KernelFileLockHandle {
  private released = false;

  constructor(
    readonly path: string,
    private readonly fd: number,
    private readonly binding: KernelFileLockBinding,
  ) {}

  get held(): boolean {
    return this.checkHeld();
  }

  checkHeld(): boolean {
    if (this.released) return false;
    try {
      const opened = fstatSync(this.fd);
      const current = statSync(this.path);
      return opened.dev === current.dev && opened.ino === current.ino;
    } catch {
      return false;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      this.binding.flockSync(this.fd, 'un');
    } finally {
      closeSync(this.fd);
    }
  }
}

export function setKernelFileLockBindingLoader(
  loader: KernelFileLockBindingLoader | undefined,
): void {
  const target = globalThis as GlobalWithBindingLoader;
  if (loader === undefined) {
    delete target[bindingLoaderKey];
  } else {
    target[bindingLoaderKey] = loader;
  }
  binding = undefined;
}

export function tryAcquireKernelFileLock(path: string): KernelFileLockHandle | undefined {
  const nativeBinding = getBinding();
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a+', 0o600);
  try {
    nativeBinding.flockSync(fd, 'exnb');
    return new KernelFileLockHandleImpl(path, fd, nativeBinding);
  } catch (error) {
    closeSync(fd);
    if (isBusy(error)) return undefined;
    throw error;
  }
}

export async function acquireKernelFileLock(
  path: string,
  options: KernelFileLockAcquireOptions,
): Promise<KernelFileLockHandle> {
  const deadline = Date.now() + options.timeoutMs;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  let firstAttempt = true;
  for (;;) {
    const isFirstAttempt = firstAttempt;
    if (!isFirstAttempt && Date.now() >= deadline) {
      throw new KernelFileLockTimeoutError(path, options.timeoutMs);
    }
    firstAttempt = false;
    const handle = tryAcquireKernelFileLock(path);
    if (handle !== undefined) {
      if (!isFirstAttempt && Date.now() >= deadline) {
        handle.release();
        throw new KernelFileLockTimeoutError(path, options.timeoutMs);
      }
      return handle;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new KernelFileLockTimeoutError(path, options.timeoutMs);
    }
    await sleep(Math.min(retryIntervalMs, remainingMs));
  }
}

export class KernelFileLockTimeoutError extends Error {
  readonly code = 'ELOCKTIMEOUT';

  constructor(
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`timed out waiting ${timeoutMs}ms for kernel file lock: ${path}`);
    this.name = 'KernelFileLockTimeoutError';
  }
}
