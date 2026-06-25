import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, win32 as pathWin32 } from 'node:path';

import { KIMI_BUILD_INFO } from '#/cli/build-info';
import { NATIVE_ASSET_MANIFEST_VERSION as MANIFEST_VERSION, buildManifestKey } from './manifest-keys';

export const NATIVE_ASSET_MANIFEST_VERSION = MANIFEST_VERSION;

export interface NativeAssetFile {
  readonly assetKey: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly mode?: number;
}

export interface NativeAssetPackage {
  readonly name: string;
  readonly root: string;
  readonly files: readonly NativeAssetFile[];
}

export interface NativeAssetManifest {
  readonly version: typeof NATIVE_ASSET_MANIFEST_VERSION;
  readonly target: string;
  readonly packages: readonly NativeAssetPackage[];
}

export interface NativeAssetSource {
  getAssetKeys(): readonly string[];
  getRawAsset(assetKey: string): ArrayBuffer | ArrayBufferView | Buffer | string;
}

export interface NativeAssetOptions {
  readonly source?: NativeAssetSource | null;
  readonly manifest?: NativeAssetManifest | null;
  readonly cacheBase?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly version?: string;
}

type RawNativeAssetManifest = Omit<NativeAssetManifest, 'version'> & {
  readonly version: number;
};

interface NodeSeaModule {
  isSea(): boolean;
  getAssetKeys(): string[];
  getRawAsset(assetKey: string): ArrayBuffer;
}

const nodeRequire = createRequire(import.meta.url);
let seaModule: NodeSeaModule | null | undefined;

function loadSeaModule(): NodeSeaModule | null {
  if (seaModule !== undefined) return seaModule;
  try {
    seaModule = nodeRequire('node:sea') as NodeSeaModule;
  } catch {
    seaModule = null;
  }
  return seaModule;
}

function currentTarget(): string {
  return KIMI_BUILD_INFO.buildTarget ?? `${process.platform}-${process.arch}`;
}

export function nativeAssetManifestKey(target: string = currentTarget()): string {
  return buildManifestKey(target);
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

function optionalEnvValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sanitizeSegment(value: string): string {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'unknown';
}

export function getSeaAssetSource(): NativeAssetSource | null {
  const sea = loadSeaModule();
  if (sea === null || !sea.isSea()) return null;
  return {
    getAssetKeys: () => sea.getAssetKeys(),
    getRawAsset: (assetKey) => sea.getRawAsset(assetKey),
  };
}

export function getEmbeddedNativeAssetManifest(
  source = getSeaAssetSource(),
  target = currentTarget(),
): NativeAssetManifest | null {
  if (source === null) return null;
  const key = nativeAssetManifestKey(target);
  if (!source.getAssetKeys().includes(key)) return null;
  const raw = source.getRawAsset(key);
  const manifest = JSON.parse(toBuffer(raw).toString('utf-8')) as RawNativeAssetManifest;
  if (manifest.version !== NATIVE_ASSET_MANIFEST_VERSION) {
    throw new Error(`Unsupported native asset manifest version: ${manifest.version}`);
  }
  if (manifest.target !== target) {
    throw new Error(`Native asset manifest target mismatch: ${manifest.target} !== ${target}`);
  }
  return manifest as NativeAssetManifest;
}

export function getNativeCacheBase(options: NativeAssetOptions = {}): string {
  if (options.cacheBase !== undefined) return options.cacheBase;

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();

  const cacheDirEnv = optionalEnvValue(env, 'KIMI_CODE_CACHE_DIR');
  if (cacheDirEnv !== null) return cacheDirEnv;

  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'kimi-code');
  if (platform === 'win32') {
    const localAppData = optionalEnvValue(env, 'LOCALAPPDATA');
    return localAppData !== null
      ? pathWin32.join(localAppData, 'kimi-code')
      : pathWin32.join(home, 'AppData', 'Local', 'kimi-code', 'Cache');
  }

  return join(optionalEnvValue(env, 'XDG_CACHE_HOME') ?? join(home, '.cache'), 'kimi-code');
}

export function getNativeAssetCacheRoot(
  manifest: NativeAssetManifest,
  options: NativeAssetOptions = {},
): string {
  const version = sanitizeSegment(options.version ?? KIMI_BUILD_INFO.version ?? 'dev');
  const manifestHash = sha256(JSON.stringify(manifest));
  return join(
    getNativeCacheBase(options),
    'native',
    version,
    sanitizeSegment(manifest.target),
    manifestHash,
  );
}

function readFileSha256(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

function ensureFile(path: string, bytes: Buffer, expectedSha256: string, mode?: number): void {
  if (readFileSha256(path) === expectedSha256) return;

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, bytes, { mode: mode ?? 0o644 });

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

function ensureEntryFile(cacheRoot: string): void {
  const entryPath = join(cacheRoot, 'node_modules', '.kimi-native-entry.cjs');
  ensureFile(
    entryPath,
    Buffer.from('module.exports = require;\n'),
    sha256('module.exports = require;\n'),
    0o644,
  );
}

export function ensureNativeAssetTree(options: NativeAssetOptions = {}): string | null {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return null;

  const manifest =
    options.manifest ?? getEmbeddedNativeAssetManifest(source, currentTarget());
  if (manifest === null) return null;

  const cacheRoot = getNativeAssetCacheRoot(manifest, options);
  for (const pkg of manifest.packages) {
    for (const file of pkg.files) {
      const bytes = toBuffer(source.getRawAsset(file.assetKey));
      const actualSha256 = sha256(bytes);
      if (actualSha256 !== file.sha256) {
        throw new Error(
          `Native asset checksum mismatch for ${file.assetKey}: ${actualSha256} !== ${file.sha256}`,
        );
      }
      ensureFile(join(cacheRoot, file.relativePath), bytes, file.sha256, file.mode);
    }
  }
  ensureEntryFile(cacheRoot);
  return cacheRoot;
}

export function getNativePackageRoot(
  packageName: string,
  options: NativeAssetOptions = {},
): string | null {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return null;

  const manifest =
    options.manifest ?? getEmbeddedNativeAssetManifest(source, currentTarget());
  if (manifest === null) return null;

  const pkg = manifest.packages.find((entry) => entry.name === packageName);
  if (pkg === undefined) return null;

  const cacheRoot = ensureNativeAssetTree({ ...options, source, manifest });
  return cacheRoot === null ? null : join(cacheRoot, pkg.root);
}

export function hasNativePackage(packageName: string, manifest: NativeAssetManifest): boolean {
  return manifest.packages.some((pkg) => pkg.name === packageName);
}

export function nativeAssetCacheExists(
  packageName: string,
  options: NativeAssetOptions = {},
): boolean {
  const root = getNativePackageRoot(packageName, options);
  return root !== null && existsSync(root);
}

export interface CleanupOptions {
  readonly cacheBase: string;
  readonly version: string;
  readonly target: string;
  readonly currentRoot: string;
}

export interface CleanupResult {
  readonly kept: string[];
  readonly removed: string[];
  readonly errors: Array<{ path: string; error: unknown }>;
}

/**
 * Remove stale native asset cache directories for the current (version, target).
 *
 * Keeps:
 *   - the currentRoot (passed in by caller)
 *   - the most recently modified sibling (defensive: in case currentRoot calc changed)
 *
 * Deletes all other sibling <manifest-hash> directories. Other versions and
 * other targets are never touched. Errors per-entry are collected and returned
 * (never throw — this is fire-and-forget background work).
 */
export function cleanupStaleNativeCache(options: CleanupOptions): CleanupResult {
  const { cacheBase, version, target, currentRoot } = options;
  const targetDir = join(cacheBase, 'native', version, target);
  const result: CleanupResult = { kept: [], removed: [], errors: [] };

  let entries: string[];
  try {
    entries = readdirSync(targetDir);
  } catch {
    return result;
  }

  const siblings: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of entries) {
    const path = join(targetDir, name);
    try {
      const st = statSync(path);
      if (!st.isDirectory()) continue;
      siblings.push({ path, mtimeMs: st.mtimeMs });
    } catch (error) {
      (result.errors as Array<{ path: string; error: unknown }>).push({ path, error });
    }
  }

  if (siblings.length === 0) return result;

  // sort newest first
  siblings.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Defensive: keep the most recently modified sibling that is not currentRoot
  // so a previously-written cache survives in case currentRoot calc changed.
  const mostRecentOther = siblings.find((entry) => entry.path !== currentRoot)?.path;
  const keepSet = new Set<string>(
    mostRecentOther === undefined ? [currentRoot] : [currentRoot, mostRecentOther],
  );

  for (const { path } of siblings) {
    if (keepSet.has(path)) {
      result.kept.push(path);
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true });
      result.removed.push(path);
    } catch (error) {
      (result.errors as Array<{ path: string; error: unknown }>).push({ path, error });
    }
  }

  return result;
}

/**
 * Convenience: discover currentRoot from embedded manifest + run cleanup.
 * Safe to call without args from main.ts startup. Returns null if not in SEA mode.
 */
export function cleanupStaleNativeCacheForCurrent(
  options: NativeAssetOptions = {},
): CleanupResult | null {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return null;

  const manifest =
    options.manifest ?? getEmbeddedNativeAssetManifest(source, currentTarget());
  if (manifest === null) return null;

  const cacheBase = getNativeCacheBase(options);
  const version = KIMI_BUILD_INFO.version ?? 'dev';
  const currentRoot = getNativeAssetCacheRoot(manifest, options);

  return cleanupStaleNativeCache({
    cacheBase,
    version,
    target: manifest.target,
    currentRoot,
  });
}
