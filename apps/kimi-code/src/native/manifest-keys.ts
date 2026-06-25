/**
 * Shared manifest constants and key builders for native / web asset manifests.
 *
 * These values are stable and MUST stay in sync with scripts/native/manifest.mjs.
 * Build scripts (under scripts/native/) use manifest.mjs directly because they
 * run as plain .mjs without TypeScript compilation. Production code in src/native/
 * imports from here instead.
 */

export const NATIVE_ASSET_MANIFEST_VERSION = 1;
export const WEB_ASSET_MANIFEST_VERSION = 1;

export function buildManifestKey(target: string): string {
  return `native/${target}/manifest.json`;
}

export function isManifestVersionSupported(version: number): boolean {
  return version === NATIVE_ASSET_MANIFEST_VERSION;
}

export function buildAssetKey(target: string, packageRoot: string, relativePath: string): string {
  return `native/${target}/${packageRoot}/${relativePath}`;
}

export function buildWebManifestKey(target: string): string {
  return `web/${target}/manifest.json`;
}

export function buildWebAssetKey(target: string, relativePath: string): string {
  return `web/${target}/dist-web/${relativePath}`;
}
