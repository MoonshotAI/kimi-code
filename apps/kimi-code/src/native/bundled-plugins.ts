import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { KIMI_BUILD_INFO } from '#/cli/build-info';
import {
  getNativeCacheBase,
  getSeaAssetSource,
  type NativeAssetSource,
} from './native-assets';
import {
  BUNDLED_PLUGINS_MANIFEST_VERSION as MANIFEST_VERSION,
  buildBundledPluginsManifestKey,
} from '../../scripts/native/manifest.mjs';

export const BUNDLED_PLUGINS_MANIFEST_VERSION = MANIFEST_VERSION;

/**
 * The environment variable the engine's capability domain reads to locate the
 * bundled wiring plugins. Kept in sync with `BUNDLED_PLUGINS_DIR_ENV` in
 * `packages/agent-core-v2/src/app/capability/bundledPlugins.ts` — the app
 * cannot import the engine constant (layering), so both sides pin the string.
 */
export const BUNDLED_PLUGINS_DIR_ENV = 'KIMI_CODE_BUNDLED_PLUGINS_DIR';

export interface BundledPluginsFile {
  readonly assetKey: string;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface BundledPluginsManifest {
  readonly version: typeof BUNDLED_PLUGINS_MANIFEST_VERSION;
  readonly target: string;
  readonly root: 'bundled-plugins';
  readonly files: readonly BundledPluginsFile[];
}

export type BundledPluginsSource = NativeAssetSource;

export interface BundledPluginsOptions {
  readonly source?: BundledPluginsSource | null;
  readonly manifest?: BundledPluginsManifest | null;
  readonly cacheBase?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly version?: string;
}

type RawBundledPluginsManifest = Omit<BundledPluginsManifest, 'version' | 'root'> & {
  readonly version: number;
  readonly root: string;
};

function currentTarget(): string {
  return KIMI_BUILD_INFO.buildTarget ?? `${process.platform}-${process.arch}`;
}

function toBuffer(value: ArrayBuffer | ArrayBufferView | Buffer | string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(value);
}

function sha256(bytes: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sanitizeSegment(value: string): string {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'unknown';
}

function readFileSha256(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

function ensureFile(path: string, bytes: Buffer, expectedSha256: string): void {
  if (readFileSha256(path) === expectedSha256) return;

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, bytes, { mode: 0o644 });

  try {
    renameSync(tempPath, path);
    return;
  } catch {
    if (readFileSha256(path) === expectedSha256) {
      rmSync(tempPath, { force: true });
      return;
    }
  }

  try {
    rmSync(path, { force: true });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    if (readFileSha256(path) === expectedSha256) return;
    throw error;
  }
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.split('/').includes('..') ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new Error(`Invalid bundled plugin relative path: ${relativePath}`);
  }
}

export function bundledPluginsManifestKey(target: string = currentTarget()): string {
  return buildBundledPluginsManifestKey(target);
}

export function getEmbeddedBundledPluginsManifest(
  source: BundledPluginsSource | null = getSeaAssetSource(),
  target = currentTarget(),
): BundledPluginsManifest | null {
  if (source === null) return null;
  const key = bundledPluginsManifestKey(target);
  if (!source.getAssetKeys().includes(key)) return null;
  const raw = source.getRawAsset(key);
  const manifest = JSON.parse(toBuffer(raw).toString('utf-8')) as RawBundledPluginsManifest;
  if (manifest.version !== BUNDLED_PLUGINS_MANIFEST_VERSION) {
    throw new Error(`Unsupported bundled plugins manifest version: ${manifest.version}`);
  }
  if (manifest.target !== target) {
    throw new Error(`Bundled plugins manifest target mismatch: ${manifest.target} !== ${target}`);
  }
  if (manifest.root !== 'bundled-plugins') {
    throw new Error(`Unsupported bundled plugins root: ${manifest.root}`);
  }
  return manifest as BundledPluginsManifest;
}

export function getBundledPluginsCacheRoot(
  manifest: BundledPluginsManifest,
  options: BundledPluginsOptions = {},
): string {
  const version = sanitizeSegment(options.version ?? KIMI_BUILD_INFO.version ?? 'dev');
  const manifestHash = sha256(JSON.stringify(manifest));
  return join(
    getNativeCacheBase({
      cacheBase: options.cacheBase,
      env: options.env,
      platform: options.platform,
      homeDir: options.homeDir,
    }),
    'bundled-plugins',
    version,
    sanitizeSegment(manifest.target),
    manifestHash,
    manifest.root,
  );
}

/**
 * Extract the embedded bundled capability plugins (kimi-cu / kimi-webbridge
 * wiring) into the native asset cache and return the directory that holds one
 * `<plugin-id>/` subdirectory per plugin. Returns null when this is not a SEA
 * build or the blob predates bundled plugins — callers then leave the
 * engine's own npm/dev probes to find the plugins.
 */
export function getNativeBundledPluginsDir(options: BundledPluginsOptions = {}): string | null {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return null;

  const manifest = options.manifest ?? getEmbeddedBundledPluginsManifest(source, currentTarget());
  if (manifest === null) return null;

  const cacheRoot = getBundledPluginsCacheRoot(manifest, options);
  for (const file of manifest.files) {
    assertSafeRelativePath(file.relativePath);
    const bytes = toBuffer(source.getRawAsset(file.assetKey));
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== file.sha256) {
      throw new Error(
        `Bundled plugin checksum mismatch for ${file.assetKey}: ${actualSha256} !== ${file.sha256}`,
      );
    }
    ensureFile(join(cacheRoot, file.relativePath), bytes, file.sha256);
  }
  return cacheRoot;
}

/**
 * Publish the extracted bundled-plugins directory to the engine's capability
 * domain (which reads `KIMI_CODE_BUNDLED_PLUGINS_DIR`). No-op outside SEA
 * builds, where the npm layout / source checkout probes already resolve.
 */
export function publishNativeBundledPluginsDir(
  options: BundledPluginsOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env[BUNDLED_PLUGINS_DIR_ENV] !== undefined) return;
  const dir = getNativeBundledPluginsDir(options);
  if (dir !== null) {
    env[BUNDLED_PLUGINS_DIR_ENV] = dir;
  }
}
