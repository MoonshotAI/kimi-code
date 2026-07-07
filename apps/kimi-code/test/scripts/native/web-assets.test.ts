import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectWebAssets,
  webAssetManifestKey,
  WEB_ASSET_MANIFEST_VERSION,
} from '../../../scripts/native/web-assets.mjs';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('collectWebAssets', () => {
  it('collects dist-web files into deterministic SEA asset keys', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'kimi-web-assets-build-'));
    try {
      mkdirSync(join(appRoot, 'dist-web', 'assets'), { recursive: true });
      writeFileSync(join(appRoot, 'dist-web', 'index.html'), '<div id="app"></div>\n');
      writeFileSync(join(appRoot, 'dist-web', 'assets', 'app.js'), 'console.log("ok");\n');

      const { manifest, manifestJson, assets } = await collectWebAssets({
        appRoot,
        target: 'test-target',
      });

      expect(webAssetManifestKey('test-target')).toBe('web/test-target/manifest.json');
      expect(manifest).toEqual({
        version: WEB_ASSET_MANIFEST_VERSION,
        target: 'test-target',
        root: 'dist-web',
        files: [
          {
            assetKey: 'web/test-target/dist-web/assets/app.js',
            relativePath: 'assets/app.js',
            sha256: sha256('console.log("ok");\n'),
          },
          {
            assetKey: 'web/test-target/dist-web/index.html',
            relativePath: 'index.html',
            sha256: sha256('<div id="app"></div>\n'),
          },
        ],
      });
      expect(JSON.parse(manifestJson) as unknown).toEqual(manifest);
      expect(assets).toEqual({
        'web/test-target/dist-web/assets/app.js': join(appRoot, 'dist-web', 'assets', 'app.js'),
        'web/test-target/dist-web/index.html': join(appRoot, 'dist-web', 'index.html'),
      });
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it('fails clearly when dist-web has not been built', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'kimi-web-assets-missing-'));
    try {
      await expect(collectWebAssets({ appRoot, target: 'test-target' })).rejects.toThrow(
        /Kimi web build output was not found/,
      );
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it('keeps manifest JSON parseable and stable', async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'kimi-web-assets-json-'));
    try {
      mkdirSync(join(appRoot, 'dist-web'), { recursive: true });
      writeFileSync(join(appRoot, 'dist-web', 'index.html'), '<html></html>');

      const { manifestJson } = await collectWebAssets({ appRoot, target: 'test-target' });

      expect(readFileSync(join(appRoot, 'dist-web', 'index.html'), 'utf-8')).toBe('<html></html>');
      expect(manifestJson.endsWith('\n')).toBe(true);
      expect(JSON.parse(manifestJson)).toMatchObject({
        version: WEB_ASSET_MANIFEST_VERSION,
        target: 'test-target',
        root: 'dist-web',
      });
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });
});
