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
import { dirname, isAbsolute, join, relative, resolve, win32 as pathWin32 } from 'node:path';
import { join as joinPosix } from 'pathe';

import { KIMI_BUILD_INFO } from '#/cli/build-info';
import {
  MINIDB_TEXT_BUILD_WORKER_ASSET,
  NATIVE_ASSET_MANIFEST_VERSION as MANIFEST_VERSION,
  buildManifestKey,
} from '../../scripts/native/manifest.mjs';

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

export interface NativeRuntimeAssetFile extends NativeAssetFile {
  readonly key: string;
}

export interface NativeAssetManifest {
  readonly version: typeof NATIVE_ASSET_MANIFEST_VERSION;
  readonly target: string;
  readonly packages: readonly NativeAssetPackage[];
  readonly runtimeFiles: readonly NativeRuntimeAssetFile[];
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

function manifestObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid native asset manifest: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function manifestString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid native asset manifest: ${label} must be a non-empty string`);
  }
  return value;
}

function validateRelativePath(value: unknown, label: string): string {
  const path = manifestString(value, label);
  const segments = path.split(/[\\/]/);
  if (
    isAbsolute(path) ||
    /^[a-zA-Z]:/.test(path) ||
    path.startsWith('\\\\') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid native asset manifest: ${label} must be a safe relative path`);
  }
  return path;
}

function validateAssetFile(
  value: unknown,
  label: string,
  assetKeys: Set<string>,
  relativePaths: Set<string>,
): NativeAssetFile {
  const file = manifestObject(value, label);
  const assetKey = manifestString(file['assetKey'], `${label}.assetKey`);
  if (assetKeys.has(assetKey)) {
    throw new Error(`Invalid native asset manifest: duplicate assetKey ${assetKey}`);
  }
  assetKeys.add(assetKey);
  const relativePath = validateRelativePath(file['relativePath'], `${label}.relativePath`);
  const portableRelativePath = relativePath.replaceAll('\\', '/');
  if (relativePaths.has(portableRelativePath)) {
    throw new Error(`Invalid native asset manifest: duplicate relativePath ${relativePath}`);
  }
  relativePaths.add(portableRelativePath);
  const fileSha256 = file['sha256'];
  if (typeof fileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(fileSha256)) {
    throw new Error(`Invalid native asset manifest: ${label}.sha256 must be 64 lowercase hex characters`);
  }
  const mode = file['mode'];
  if (
    mode !== undefined &&
    (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o777)
  ) {
    throw new Error(`Invalid native asset manifest: ${label}.mode must be an integer between 0 and 0777`);
  }
  return {
    assetKey,
    relativePath,
    sha256: fileSha256,
    mode: mode as number | undefined,
  };
}

export function validateNativeAssetManifest(
  value: unknown,
  expectedTarget?: string,
): NativeAssetManifest {
  const manifest = manifestObject(value, 'root');
  if (manifest['version'] !== NATIVE_ASSET_MANIFEST_VERSION) {
    throw new Error(`Unsupported native asset manifest version: ${String(manifest['version'])}`);
  }
  const target = manifestString(manifest['target'], 'target');
  if (expectedTarget !== undefined && target !== expectedTarget) {
    throw new Error(`Native asset manifest target mismatch: ${target} !== ${expectedTarget}`);
  }
  const manifestPackages = manifest['packages'];
  if (!Array.isArray(manifestPackages)) {
    throw new TypeError('Invalid native asset manifest: packages must be an array');
  }
  const manifestRuntimeFiles = manifest['runtimeFiles'];
  if (!Array.isArray(manifestRuntimeFiles)) {
    throw new TypeError('Invalid native asset manifest: runtimeFiles must be an array');
  }

  const assetKeys = new Set<string>();
  const relativePaths = new Set<string>();
  const packageNames = new Set<string>();
  const packages = manifestPackages.map((value, packageIndex): NativeAssetPackage => {
    const label = `packages[${packageIndex}]`;
    const pkg = manifestObject(value, label);
    const name = manifestString(pkg['name'], `${label}.name`);
    if (packageNames.has(name)) {
      throw new Error(`Invalid native asset manifest: duplicate package name ${name}`);
    }
    packageNames.add(name);
    const root = validateRelativePath(pkg['root'], `${label}.root`);
    const packageFiles = pkg['files'];
    if (!Array.isArray(packageFiles)) {
      throw new TypeError(`Invalid native asset manifest: ${label}.files must be an array`);
    }
    return {
      name,
      root,
      files: packageFiles.map((file, fileIndex) =>
        validateAssetFile(file, `${label}.files[${fileIndex}]`, assetKeys, relativePaths),
      ),
    };
  });

  const runtimeKeys = new Set<string>();
  const runtimeFiles = manifestRuntimeFiles.map((value, index): NativeRuntimeAssetFile => {
    const label = `runtimeFiles[${index}]`;
    const raw = manifestObject(value, label);
    const key = manifestString(raw['key'], `${label}.key`);
    if (runtimeKeys.has(key)) {
      throw new Error(`Invalid native asset manifest: duplicate runtime key ${key}`);
    }
    runtimeKeys.add(key);
    return {
      ...validateAssetFile(raw, label, assetKeys, relativePaths),
      key,
    };
  });

  return {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target,
    packages,
    runtimeFiles,
  };
}

function resolveAssetPath(cacheRoot: string, relativePath: string): string {
  const path = resolve(cacheRoot, ...relativePath.split(/[\\/]/));
  const fromRoot = relative(cacheRoot, path);
  if (fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\') || isAbsolute(fromRoot)) {
    throw new Error(`Native asset path escapes cache root: ${relativePath}`);
  }
  return path;
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
  const parsed: unknown = JSON.parse(toBuffer(raw).toString('utf-8'));
  validateNativeAssetManifest(parsed, target);
  return parsed as NativeAssetManifest;
}

export function getNativeCacheBase(options: NativeAssetOptions = {}): string {
  if (options.cacheBase !== undefined) return options.cacheBase;

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();

  const cacheDirEnv = optionalEnvValue(env, 'KIMI_CODE_CACHE_DIR');
  if (cacheDirEnv !== null) return cacheDirEnv;

  if (platform === 'darwin') return joinPosix(home, 'Library', 'Caches', 'kimi-code');
  if (platform === 'win32') {
    const localAppData = optionalEnvValue(env, 'LOCALAPPDATA');
    return localAppData !== null
      ? pathWin32.join(localAppData, 'kimi-code')
      : pathWin32.join(home, 'AppData', 'Local', 'kimi-code', 'Cache');
  }

  return joinPosix(optionalEnvValue(env, 'XDG_CACHE_HOME') ?? joinPosix(home, '.cache'), 'kimi-code');
}

export function getNativeAssetCacheRoot(
  manifest: NativeAssetManifest,
  options: NativeAssetOptions = {},
): string {
  const validated = validateNativeAssetManifest(manifest);
  const version = sanitizeSegment(options.version ?? KIMI_BUILD_INFO.version ?? 'dev');
  const manifestHash = sha256(JSON.stringify(manifest));
  return join(
    getNativeCacheBase(options),
    'native',
    version,
    sanitizeSegment(validated.target),
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

  const rawManifest =
    options.manifest ?? getEmbeddedNativeAssetManifest(source, currentTarget());
  if (rawManifest === null) return null;
  const manifest = validateNativeAssetManifest(rawManifest);

  const cacheRoot = getNativeAssetCacheRoot(rawManifest, options);
  const sourceKeys = new Set(source.getAssetKeys());
  const files = [
    ...manifest.packages.flatMap((pkg) => pkg.files),
    ...manifest.runtimeFiles,
  ];
  for (const file of files) {
    if (!sourceKeys.has(file.assetKey)) {
      throw new Error(`Native asset is missing: ${file.assetKey}`);
    }
    const bytes = toBuffer(source.getRawAsset(file.assetKey));
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== file.sha256) {
      throw new Error(
        `Native asset checksum mismatch for ${file.assetKey}: ${actualSha256} !== ${file.sha256}`,
      );
    }
    ensureFile(resolveAssetPath(cacheRoot, file.relativePath), bytes, file.sha256, file.mode);
  }
  ensureEntryFile(cacheRoot);
  return cacheRoot;
}

export function getNativeRuntimeFile(
  key: string,
  options: NativeAssetOptions = {},
): string | null {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return null;

  const rawManifest =
    options.manifest ?? getEmbeddedNativeAssetManifest(source, currentTarget());
  if (rawManifest === null) return null;
  const manifest = validateNativeAssetManifest(rawManifest);

  const file = manifest.runtimeFiles.find((entry) => entry.key === key);
  if (file === undefined) return null;

  const cacheRoot = ensureNativeAssetTree({ ...options, source, manifest: rawManifest });
  return cacheRoot === null ? null : resolveAssetPath(cacheRoot, file.relativePath);
}

export function getMinidbTextBuildWorkerFile(
  options: NativeAssetOptions = {},
): string | null {
  return getNativeRuntimeFile(MINIDB_TEXT_BUILD_WORKER_ASSET.key, options);
}

export function getNativePackageRoot(
  packageName: string,
  options: NativeAssetOptions = {},
): string | null {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return null;

  const rawManifest =
    options.manifest ?? getEmbeddedNativeAssetManifest(source, currentTarget());
  if (rawManifest === null) return null;
  const manifest = validateNativeAssetManifest(rawManifest);

  const pkg = manifest.packages.find((entry) => entry.name === packageName);
  if (pkg === undefined) return null;

  const cacheRoot = ensureNativeAssetTree({ ...options, source, manifest: rawManifest });
  return cacheRoot === null ? null : resolveAssetPath(cacheRoot, pkg.root);
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
