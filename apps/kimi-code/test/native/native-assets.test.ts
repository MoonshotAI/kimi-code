import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getNativeCacheBase,
  getNativePackageRoot,
  NATIVE_ASSET_MANIFEST_VERSION,
  type NativeAssetManifest,
  type NativeAssetSource,
} from '#/native/native-assets';
import { loadNativePackage, loadNativePackageFile } from '#/native/native-require';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeManifest(files: Record<string, string>): {
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
  const manifest: NativeAssetManifest = {
    version: NATIVE_ASSET_MANIFEST_VERSION,
    target: 'test-target',
    packages: [
      {
        name: 'fake-native',
        root: 'node_modules/fake-native',
        files: assetEntries,
      },
    ],
  };
  const manifestKey = 'native/test-target/manifest.json';
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

  it('loads a package file from extracted native assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-file-require-'));
    try {
      const { manifest, source } = fakeManifest({
        'node_modules/fake-native/package.json': '{}',
        'node_modules/fake-native/prebuilds/test-target/addon.cjs':
          "module.exports = { value: 'native' };\n",
      });

      const addon = loadNativePackageFile<{ value: string }>(
        'fake-native',
        join('prebuilds', 'test-target', 'addon.cjs'),
        {
          cacheBase: dir,
          manifest,
          source,
          version: 'test',
        },
      );

      expect(addon).toEqual({ value: 'native' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
