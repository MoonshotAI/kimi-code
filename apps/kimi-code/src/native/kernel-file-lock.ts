import {
  setKernelFileLockBindingLoader,
  type KernelFileLockBinding,
} from '@moonshot-ai/kernel-file-lock';

import { loadNativePackage } from './native-require';

export function installKernelFileLockNativeBinding(): void {
  setKernelFileLockBindingLoader(() =>
    loadNativePackage<KernelFileLockBinding>('fs-ext-extra-prebuilt') ?? undefined,
  );
}
