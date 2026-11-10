import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  getTextBuildWorkerRuntimeState,
  resetTextBuildWorkerRuntime,
} from '@moonshot-ai/minidb/worker-runtime';

import {
  getEmbeddedNativeAssetManifest,
  getMinidbTextBuildWorkerFile,
  getNativeCacheBase,
  getNativePackageRoot,
  NATIVE_ASSET_MANIFEST_VERSION,
  type NativeAssetManifest,
  type NativeAssetSource,
} from '#/native/native-assets';
import { installMinidbTextBuildWorker } from '#/native/minidb-worker';
import { loadNativePackage } from '#/native/native-require';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeManifest(files: Record<string, string>, workerContent?: string): {
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
  const workerAssetKey = 'native/test-target/runtime/minidb-text-build-worker';
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
    runtimeFiles:
      workerContent === undefined
        ? []
        : [
            {
              key: 'minidb-text-build-worker',
              assetKey: workerAssetKey,
              relativePath: 'runtime/minidb/text-build-worker.mjs',
              sha256: sha256(workerContent),
              mode: 0o644,
            },
          ],
  };
  const assets = new Map<string, Buffer>([
    [manifestKey, Buffer.from(JSON.stringify(manifest))],
    ...Object.entries(files).map(([relativePath, content]) => [
      `native/test-target/${relativePath}`,
      Buffer.from(content),
    ] as const),
    ...(workerContent === undefined
      ? []
      : [[workerAssetKey, Buffer.from(workerContent)] as const]),
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

afterEach(() => {
  resetTextBuildWorkerRuntime();
});

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

  it('extracts, reuses, and repairs the runtime worker in the unified cache tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-worker-'));
    try {
      const worker = 'export const worker = true;\n';
      const { manifest, source } = fakeManifest(
        { 'node_modules/fake-native/package.json': '{"main":"index.js"}' },
        worker,
      );
      const options = { cacheBase: dir, manifest, source, version: 'test' };
      const first = getMinidbTextBuildWorkerFile(options);
      const packageRoot = getNativePackageRoot('fake-native', options);
      expect(first).toBe(
        join(
          dir,
          'native',
          'test',
          'test-target',
          sha256(JSON.stringify(manifest)),
          'runtime',
          'minidb',
          'text-build-worker.mjs',
        ),
      );
      expect(packageRoot?.startsWith(join(dir, 'native', 'test', 'test-target'))).toBe(true);
      expect(getMinidbTextBuildWorkerFile(options)).toBe(first);

      writeFileSync(first!, 'corrupt');
      expect(getMinidbTextBuildWorkerFile(options)).toBe(first);
      expect(readFileSync(first!, 'utf-8')).toBe(worker);

      const installed = installMinidbTextBuildWorker(options);
      expect(installed).toMatchObject({ status: 'installed', assetSha256: sha256(worker) });
      expect(getTextBuildWorkerRuntimeState()).toMatchObject({
        configured: true,
        entry: { kind: 'packaged', path: first },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports missing and corrupt runtime worker assets without configuring MiniDb', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-native-worker-fail-'));
    try {
      const missing = fakeManifest({});
      expect(
        installMinidbTextBuildWorker({
          cacheBase: dir,
          manifest: missing.manifest,
          source: missing.source,
          version: 'test',
        }),
      ).toEqual({ status: 'asset-missing' });

      const corrupt = fakeManifest({}, 'worker');
      const corruptSource: NativeAssetSource = {
        getAssetKeys: () => corrupt.source.getAssetKeys(),
        getRawAsset: (key) =>
          key.endsWith('/runtime/minidb-text-build-worker')
            ? Buffer.from('wrong')
            : corrupt.source.getRawAsset(key),
      };
      expect(
        installMinidbTextBuildWorker({
          cacheBase: dir,
          manifest: corrupt.manifest,
          source: corruptSource,
          version: 'test',
        }),
      ).toMatchObject({ status: 'failed', errorCode: 'Error' });
      expect(getTextBuildWorkerRuntimeState()).toEqual({ configured: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported or structurally incomplete native manifest versions', () => {
    const valid = fakeManifest({}, 'worker').manifest;
    const cases: Array<{ manifest: unknown; error: RegExp }> = [
      { manifest: { ...valid, version: 1 }, error: /Unsupported native asset manifest version: 1/ },
      {
        manifest: { version: NATIVE_ASSET_MANIFEST_VERSION, target: 'test-target', runtimeFiles: [] },
        error: /packages must be an array/,
      },
      {
        manifest: { version: NATIVE_ASSET_MANIFEST_VERSION, target: 'test-target', packages: [] },
        error: /runtimeFiles must be an array/,
      },
      { manifest: { ...valid, packages: {} }, error: /packages must be an array/ },
      { manifest: { ...valid, runtimeFiles: {} }, error: /runtimeFiles must be an array/ },
    ];

    for (const item of cases) {
      expect(() =>
        getEmbeddedNativeAssetManifest(sourceForManifest(item.manifest), 'test-target'),
      ).toThrow(item.error);
    }
  });

  it('rejects unsafe paths, invalid file metadata, and duplicate manifest keys', () => {
    const valid = fakeManifest({}, 'worker').manifest;
    const worker = valid.runtimeFiles[0]!;
    const invalidRuntimeFiles: Array<{ file: Record<string, unknown>; error: RegExp }> = [
      { file: { ...worker, relativePath: '/tmp/worker.mjs' }, error: /safe relative path/ },
      { file: { ...worker, relativePath: '../worker.mjs' }, error: /safe relative path/ },
      { file: { ...worker, relativePath: 'runtime\\..\\worker.mjs' }, error: /safe relative path/ },
      { file: { ...worker, sha256: 'not-a-sha' }, error: /64 lowercase hex/ },
      { file: { ...worker, mode: 0o1000 }, error: /mode must be an integer/ },
      { file: { ...worker, assetKey: 42 }, error: /assetKey must be a non-empty string/ },
    ];
    for (const item of invalidRuntimeFiles) {
      expect(() =>
        getEmbeddedNativeAssetManifest(
          sourceForManifest({ ...valid, runtimeFiles: [item.file] }),
          'test-target',
        ),
      ).toThrow(item.error);
    }

    const validPackage = valid.packages[0]!;
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
        sourceForManifest({
          ...valid,
          runtimeFiles: [
            worker,
            { ...worker, assetKey: 'native/test-target/runtime/other', relativePath: 'runtime/other.mjs' },
          ],
        }),
        'test-target',
      ),
    ).toThrow(/duplicate runtime key/);

    expect(() =>
      getEmbeddedNativeAssetManifest(
        sourceForManifest({
          ...valid,
          runtimeFiles: [
            worker,
            {
              ...worker,
              key: 'other',
              relativePath: 'runtime/other.mjs',
            },
          ],
        }),
        'test-target',
      ),
    ).toThrow(/duplicate assetKey/);
  });
});
