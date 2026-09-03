export const NATIVE_ASSET_MANIFEST_VERSION = 2;
export const WEB_ASSET_MANIFEST_VERSION = 1;

export const MINIDB_TEXT_BUILD_WORKER_ASSET = Object.freeze({
  key: 'minidb-text-build-worker',
  relativePath: 'runtime/minidb/text-build-worker.mjs',
  mode: 0o644,
});

export const KAP_SEARCH_WORKER_ASSET = Object.freeze({
  key: 'kap-search-worker',
  relativePath: 'runtime/kap-server/search-worker.mjs',
  mode: 0o644,
});

export function buildManifestKey(target) {
  return `native/${target}/manifest.json`;
}

export function buildRuntimeAssetKey(target, key) {
  return `native/${target}/runtime/${key}`;
}

export function isManifestVersionSupported(version) {
  return version === NATIVE_ASSET_MANIFEST_VERSION;
}

export function buildAssetKey(target, packageRoot, relativePath) {
  return `native/${target}/${packageRoot}/${relativePath}`;
}

export function buildWebManifestKey(target) {
  return `web/${target}/manifest.json`;
}

export function buildWebAssetKey(target, relativePath) {
  return `web/${target}/dist-web/${relativePath}`;
}
