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
  WEB_ASSET_MANIFEST_VERSION as MANIFEST_VERSION,
  buildWebManifestKey,
} from '../../scripts/native/manifest.mjs';

export const WEB_ASSET_MANIFEST_VERSION = MANIFEST_VERSION;

export interface WebAssetFile {
  readonly assetKey: string;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface WebAssetManifest {
  readonly version: typeof WEB_ASSET_MANIFEST_VERSION;
  readonly target: string;
  readonly root: 'dist-web';
  readonly files: readonly WebAssetFile[];
}

export type WebAssetSource = NativeAssetSource;

export interface WebAssetOptions {
  readonly source?: WebAssetSource | null;
  readonly manifest?: WebAssetManifest | null;
  readonly cacheBase?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly version?: string;
}

type RawWebAssetManifest = Omit<WebAssetManifest, 'version' | 'root'> & {
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
    throw new Error(`Invalid web asset relative path: ${relativePath}`);
  }
}

export function webAssetManifestKey(target: string = currentTarget()): string {
  return buildWebManifestKey(target);
}

export function getEmbeddedWebAssetManifest(
  source: WebAssetSource | null = getSeaAssetSource(),
  target = currentTarget(),
): WebAssetManifest | null {
  if (source === null) return null;
  const key = webAssetManifestKey(target);
  if (!source.getAssetKeys().includes(key)) return null;
  const raw = source.getRawAsset(key);
  const manifest = JSON.parse(toBuffer(raw).toString('utf-8')) as RawWebAssetManifest;
  if (manifest.version !== WEB_ASSET_MANIFEST_VERSION) {
    throw new Error(`Unsupported web asset manifest version: ${manifest.version}`);
  }
  if (manifest.target !== target) {
    throw new Error(`Web asset manifest target mismatch: ${manifest.target} !== ${target}`);
  }
  if (manifest.root !== 'dist-web') {
    throw new Error(`Unsupported web asset root: ${manifest.root}`);
  }
  return manifest as WebAssetManifest;
}

export function getWebAssetCacheRoot(
  manifest: WebAssetManifest,
  options: WebAssetOptions = {},
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
    'web',
    version,
    sanitizeSegment(manifest.target),
    manifestHash,
    manifest.root,
  );
}

export function getNativeWebAssetsDir(options: WebAssetOptions = {}): string | null {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return null;

  const manifest = options.manifest ?? getEmbeddedWebAssetManifest(source, currentTarget());
  if (manifest === null) return null;

  const cacheRoot = getWebAssetCacheRoot(manifest, options);
  for (const file of manifest.files) {
    assertSafeRelativePath(file.relativePath);
    const bytes = toBuffer(source.getRawAsset(file.assetKey));
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== file.sha256) {
      throw new Error(
        `Web asset checksum mismatch for ${file.assetKey}: ${actualSha256} !== ${file.sha256}`,
      );
    }
    ensureFile(join(cacheRoot, file.relativePath), bytes, file.sha256);
  }
  return cacheRoot;
}
