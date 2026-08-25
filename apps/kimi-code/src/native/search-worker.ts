import { basename } from 'node:path';

import {
  configureSearchWorkerRuntime,
  getSearchWorkerRuntimeState,
} from '@moonshot-ai/kap-server/search-worker-runtime';

import { KAP_SEARCH_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getEmbeddedNativeAssetManifest,
  getKapSearchWorkerFile,
  getSeaAssetSource,
  type NativeAssetOptions,
} from './native-assets';

export type KapSearchWorkerInstallStatus =
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

/**
 * Install the SEA-bundled global-search worker without making optional
 * extraction fatal. Without it the search service resolves no worker entry
 * inside the single-file binary and reports the index as degraded; the
 * `search_worker` experimental flag restores the in-process host.
 */
export function installKapSearchWorker(
  options: NativeAssetOptions = {},
): KapSearchWorkerInstallStatus {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return { status: 'not-sea' };

  let assetSha256: string | undefined;
  try {
    const manifest = options.manifest ?? getEmbeddedNativeAssetManifest(source);
    const file = manifest?.runtimeFiles.find((entry) => entry.key === KAP_SEARCH_WORKER_ASSET.key);
    if (manifest === null || file === undefined) return { status: 'asset-missing' };
    assetSha256 = file.sha256;

    const workerPath = getKapSearchWorkerFile({ ...options, source, manifest });
    if (workerPath === null) return { status: 'asset-missing' };
    configureSearchWorkerRuntime(workerPath);
    const runtime = getSearchWorkerRuntimeState();
    if (!runtime.configured) throw new Error('search worker runtime was not configured');
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
