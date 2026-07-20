import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  ensureNativeAssetTree,
  getNativePackageRoot,
  type NativeAssetOptions,
} from './native-assets';

export function createNativePackageRequire(
  packageName: string,
  options: NativeAssetOptions = {},
): ReturnType<typeof createRequire> | null {
  const packageRoot = getNativePackageRoot(packageName, options);
  if (packageRoot === null) return null;

  const cacheRoot = ensureNativeAssetTree(options);
  if (cacheRoot === null) return null;

  return createRequire(join(cacheRoot, 'node_modules', '.kimi-native-entry.cjs'));
}

export function loadNativePackage<T>(
  packageName: string,
  options: NativeAssetOptions = {},
): T | null {
  const nativeRequire = createNativePackageRequire(packageName, options);
  if (nativeRequire === null) return null;
  return nativeRequire(packageName) as T;
}

export function loadNativePackageFile<T>(
  packageName: string,
  relativePath: string,
  options: NativeAssetOptions = {},
): T | null {
  const packageRoot = getNativePackageRoot(packageName, options);
  if (packageRoot === null) return null;
  return createRequire(import.meta.url)(join(packageRoot, relativePath)) as T;
}
