import { join } from 'node:path';

import {
  setKernelFileLockBindingLoader,
  type KernelFileLockBinding,
} from '@moonshot-ai/agent-core-v2';

import { loadNativePackageFile } from './native-require';

interface NativeFileLockBinding {
  tryLock(fd: number, offset: number, length: number, exclusive: boolean): void;
  unlock(fd: number, offset: number, length: number): void;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function loadKernelFileLockNativeBinding(): KernelFileLockBinding | undefined {
  const target = `${process.platform}-${process.arch}`;
  const binding = loadNativePackageFile<NativeFileLockBinding>(
    'fs-native-extensions',
    join('prebuilds', target, 'fs-native-extensions.node'),
  );
  if (binding === null) return undefined;
  return {
    tryLock: (fd) => {
      try {
        binding.tryLock(fd, 0, 0, true);
        return true;
      } catch (error) {
        if (errorCode(error) === 'EAGAIN') return false;
        throw error;
      }
    },
    unlock: (fd) => {
      binding.unlock(fd, 0, 0);
    },
  };
}

export function installKernelFileLockNativeBinding(): void {
  setKernelFileLockBindingLoader(loadKernelFileLockNativeBinding);
}
