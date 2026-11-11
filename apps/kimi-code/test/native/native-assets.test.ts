import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getEmbeddedNativeAssetManifest,
  getNativeCacheBase,
  getNativePackageRoot,
  getSqliteNativeBinding,
  NATIVE_ASSET_MANIFEST_VERSION,
  type NativeAssetManifest,
  type NativeAssetSource,
} from '#/native/native-assets';
import { loadNativePackage } from '#/native/native-require';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeManifest(files: Record<string, string>, packageName = 'fake-native'): {
  manifest: NativeAssetManifest;
  source: NativeAssetSource;
} {
  const assetEntries = Object.entries(files).map(([relativePath, content]) => {
    const assetKey = `native/test-target/${relativePath}`;
    return {
      assetKey,
      relativePath,
      sha256: sha256(content),
    };
  });
  const manifestKey = 'native/test-target/manifest.json';
  const manifest: NativeAssetManifest = {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target: 'test-target',
    packages: [
      {
        name: packageName,
        root: `node_modules/${packageName}`,
        files: assetEntries,
      },
    ],
  };
  const assets = new Map<string, Buffer>([
    [manifestKey, Buffer.from(JSON.stringify(manifest))],
    ...Object.entries(files).map(([relativePath, content]) => [
      `native/test-target/${relativePath}`,
      Buffer.from(content),
    ] as const),
  ]);
  return {
    manifest,
    source: {
      getAssetKeys: () => [...assets.keys()],
      getRawAsset: (assetKey) => {
        const asset = assets.get(assetKey);
        if (asset === undefined) throw new Error(`missing test asset: ${assetKey}`);
        return asset;
      },
    },
  };
}

function sourceForManifest(manifest: unknown): NativeAssetSource {
  const key = 'native/test-target/manifest.json';
  return {
    getAssetKeys: () => [key],
    getRawAsset: (assetKey) => {
      if (assetKey !== key) throw new Error(`missing test asset: ${assetKey}`);
      return Buffer.from(JSON.stringify(manifest));
    },
  };
}

describe('native assets', () => {
  it('uses KIMI_CODE_CACHE_DIR as the native cache base when present', () => {
    expect(
      getNativeCacheBase({
        env: { KIMI_CODE_CACHE_DIR: '/tmp/kimi-cache' },
        homeDir: '/home/kimi',
        platform: 'linux',
      }),
    ).toBe('/tmp/kimi-cache');
  });

  it('extracts package assets and repairs corrupted cache files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-assets-'));
    try {
      const { manifest, source } = fakeManifest({
        'node_modules/fake-native/package.json': '{"main":"index.js"}',
        'node_modules/fake-native/index.js': "module.exports = { value: 'ok' };\n",
      });

      const packageRoot = getNativePackageRoot('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });
      expect(packageRoot).toBe(join(dir, 'native', 'test', 'test-target', sha256(JSON.stringify(manifest)), 'node_modules', 'fake-native'));
      expect(readFileSync(join(packageRoot ?? '', 'index.js'), 'utf-8')).toContain("value: 'ok'");

      writeFileSync(join(packageRoot ?? '', 'index.js'), 'broken');
      const repairedRoot = getNativePackageRoot('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });
      expect(repairedRoot).toBe(packageRoot);
      expect(readFileSync(join(repairedRoot ?? '', 'index.js'), 'utf-8')).toContain("value: 'ok'");
      expect(existsSync(join(dir, 'native', 'test', 'test-target'))).toBe(true);

      const sqlite = fakeManifest({
        'node_modules/better-sqlite3/prebuilds/test-target.node': 'sqlite native',
      }, 'better-sqlite3');
      const sqliteBinding = getSqliteNativeBinding({
        cacheBase: dir,
        manifest: sqlite.manifest,
        source: sqlite.source,
        version: 'test',
      }, 'test-target');
      expect(sqliteBinding).toBe(join(
        dir,
        'native',
        'test',
        'test-target',
        sha256(JSON.stringify(sqlite.manifest)),
        'node_modules',
        'better-sqlite3',
        'prebuilds',
        'test-target.node',
      ));
      expect(readFileSync(sqliteBinding ?? '', 'utf-8')).toBe('sqlite native');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a package from extracted native assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-require-'));
    try {
      const { manifest, source } = fakeManifest({
        'node_modules/fake-native/package.json': '{"main":"index.js"}',
        'node_modules/fake-native/index.js': "module.exports = { value: 'ok' };\n",
      });

      const pkg = loadNativePackage<{ value: string }>('fake-native', {
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });

      expect(pkg).toEqual({ value: 'ok' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported or structurally incomplete native manifest versions', () => {
    const valid = fakeManifest({}).manifest;
    const cases: Array<{ manifest: unknown; error: RegExp }> = [
      { manifest: { ...valid, version: 1 }, error: /Unsupported native asset manifest version: 1/ },
      {
        manifest: { version: NATIVE_ASSET_MANIFEST_VERSION, target: 'test-target' },
        error: /packages must be an array/,
      },
      { manifest: { ...valid, packages: {} }, error: /packages must be an array/ },
    ];

    for (const item of cases) {
      expect(() =>
        getEmbeddedNativeAssetManifest(sourceForManifest(item.manifest), 'test-target'),
      ).toThrow(item.error);
    }
  });

  it('rejects unsafe paths, invalid file metadata, and duplicate manifest entries', () => {
    const valid = fakeManifest({
      'node_modules/fake-native/index.js': "module.exports = { value: 'ok' };\n",
    }).manifest;
    const validPackage = valid.packages[0]!;
    const file = validPackage.files[0]!;
    const invalidFiles: Array<{ file: Record<string, unknown>; error: RegExp }> = [
      { file: { ...file, relativePath: '/tmp/index.js' }, error: /safe relative path/ },
      { file: { ...file, relativePath: '../index.js' }, error: /safe relative path/ },
      { file: { ...file, relativePath: 'node_modules\\..\\index.js' }, error: /safe relative path/ },
      { file: { ...file, sha256: 'not-a-sha' }, error: /64 lowercase hex/ },
      { file: { ...file, mode: 0o1000 }, error: /mode must be an integer/ },
      { file: { ...file, assetKey: 42 }, error: /assetKey must be a non-empty string/ },
    ];
    for (const item of invalidFiles) {
      expect(() =>
        getEmbeddedNativeAssetManifest(
          sourceForManifest({ ...valid, packages: [{ ...validPackage, files: [item.file] }] }),
          'test-target',
        ),
      ).toThrow(item.error);
    }

    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          packages: [{ ...validPackage, root: '../node_modules/fake-native' }],
        }),
        'test-target',
      ),
    ).toThrow(/safe relative path/);
    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          packages: [{ ...validPackage, files: {} }],
        }),
        'test-target',
      ),
    ).toThrow(/files must be an array/);
    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({ ...valid, packages: [validPackage, validPackage] }),
        'test-target',
      ),
    ).toThrow(/duplicate package name/);
    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          packages: [{
            ...validPackage,
            files: [file, { ...file, assetKey: 'native/test-target/other' }],
          }],
        }),
        'test-target',
      ),
    ).toThrow(/duplicate relativePath/);
    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          packages: [{
            ...validPackage,
            files: [file, { ...file, relativePath: 'node_modules/fake-native/other.js' }],
          }],
        }),
        'test-target',
      ),
    ).toThrow(/duplicate assetKey/);
  });
});
