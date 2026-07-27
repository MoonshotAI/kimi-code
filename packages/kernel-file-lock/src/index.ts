import { closeSync, fstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

export interface KernelFileLockBinding {
  tryLock(fd: number): boolean;
  unlock(fd: number): void;
}

export type KernelFileLockBindingLoader = () => KernelFileLockBinding | undefined;

export interface KernelFileLockHandle {
  checkHeld(): boolean;
  release(): void;
}

const bindingLoaderKey = Symbol.for('@moonshot-ai/kernel-file-lock/binding-loader');
const nodeRequire = createRequire(import.meta.url);

type GlobalWithBindingLoader = typeof globalThis & {
  [bindingLoaderKey]?: KernelFileLockBindingLoader;
};

let binding: KernelFileLockBinding | undefined;

function defaultBindingLoader(): KernelFileLockBinding {
  return nodeRequire('fs-native-extensions') as KernelFileLockBinding;
}

function getBinding(): KernelFileLockBinding {
  if (binding !== undefined) return binding;
  const override = (globalThis as GlobalWithBindingLoader)[bindingLoaderKey];
  binding = override?.() ?? defaultBindingLoader();
  return binding;
}

class KernelFileLockHandleImpl implements KernelFileLockHandle {
  private released = false;

  constructor(
    private readonly path: string,
    private readonly fd: number,
    private readonly binding: KernelFileLockBinding,
  ) {}

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
      this.binding.unlock(this.fd);
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
    if (!nativeBinding.tryLock(fd)) {
      closeSync(fd);
      return undefined;
    }
    return new KernelFileLockHandleImpl(path, fd, nativeBinding);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
