import { basename } from 'node:path';

import {
  configureTextBuildWorkerRuntime,
  getTextBuildWorkerRuntimeState,
} from '@moonshot-ai/minidb/worker-runtime';

import { MINIDB_TEXT_BUILD_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getEmbeddedNativeAssetManifest,
  getMinidbTextBuildWorkerFile,
  getSeaAssetSource,
  type NativeAssetOptions,
} from './native-assets';

export type MinidbTextBuildWorkerInstallStatus =
  | { readonly status: 'not-sea' }
  | { readonly status: 'asset-missing' }
  | {
      readonly status: 'installed';
      readonly assetSha256: string;
      readonly basename: string;
    }
  | {
      readonly status: 'failed';
      readonly errorCode: string;
      readonly assetSha256?: string;
    };

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return error instanceof Error ? error.name : 'UNKNOWN';
}

/** Install the SEA-bundled worker without making optional extraction fatal. */
export function installMinidbTextBuildWorker(
  options: NativeAssetOptions = {},
): MinidbTextBuildWorkerInstallStatus {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return { status: 'not-sea' };

  let assetSha256: string | undefined;
  try {
    const manifest = options.manifest ?? getEmbeddedNativeAssetManifest(source);
    const file = manifest?.runtimeFiles.find(
      (entry) => entry.key === MINIDB_TEXT_BUILD_WORKER_ASSET.key,
    );
    if (manifest === null || file === undefined) return { status: 'asset-missing' };
    assetSha256 = file.sha256;

    const workerPath = getMinidbTextBuildWorkerFile({ ...options, source, manifest });
    if (workerPath === null) return { status: 'asset-missing' };
    configureTextBuildWorkerRuntime(workerPath);
    const runtime = getTextBuildWorkerRuntimeState();
    if (!runtime.configured) throw new Error('MiniDb worker runtime was not configured');
    return {
      status: 'installed',
      assetSha256,
      basename: basename(workerPath),
    };
  } catch (error) {
    return {
      status: 'failed',
      errorCode: errorCode(error),
      assetSha256,
    };
  }
}
