export const NATIVE_ASSET_MANIFEST_VERSION = 1;
export const WEB_ASSET_MANIFEST_VERSION = 1;

export function buildManifestKey(target) {
  return `native/${target}/manifest.json`;
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
