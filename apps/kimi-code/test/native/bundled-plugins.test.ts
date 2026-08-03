import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BUNDLED_PLUGINS_DIR_ENV,
  BUNDLED_PLUGINS_MANIFEST_VERSION,
  getBundledPluginsCacheRoot,
  getNativeBundledPluginsDir,
  publishNativeBundledPluginsDir,
  type BundledPluginsManifest,
  type BundledPluginsSource,
} from '#/native/bundled-plugins';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeBundledPlugins(files: Record<string, string>): {
  manifest: BundledPluginsManifest;
  source: BundledPluginsSource;
} {
  const manifest: BundledPluginsManifest = {
    version: BUNDLED_PLUGINS_MANIFEST_VERSION,
    target: 'test-target',
    root: 'bundled-plugins',
    files: Object.entries(files).map(([relativePath, content]) => ({
      assetKey: `bundled-plugins/test-target/files/${relativePath}`,
      relativePath,
      sha256: sha256(content),
    })),
  };
  const assets = new Map<string, Buffer>([
    ['bundled-plugins/test-target/manifest.json', Buffer.from(JSON.stringify(manifest))],
    ...Object.entries(files).map(([relativePath, content]) => [
      `bundled-plugins/test-target/files/${relativePath}`,
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

const PLUGIN_FILES: Record<string, string> = {
  'kimi-cu/kimi.plugin.json': '{"name":"kimi-cu"}\n',
  'kimi-cu/bin/kimi-cu-mcp': '#!/bin/sh\n',
  'kimi-webbridge/kimi.plugin.json': '{"name":"kimi-webbridge"}\n',
  'kimi-webbridge/skills/kimi-webbridge/SKILL.md': '# skill\n',
};

describe('bundled plugins (native SEA assets)', () => {
  it('extracts embedded plugin files into a bundled-plugins cache directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-bundled-plugins-runtime-'));
    try {
      const { manifest, source } = fakeBundledPlugins(PLUGIN_FILES);

      const pluginsDir = getNativeBundledPluginsDir({
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });

      expect(pluginsDir).toBe(
        getBundledPluginsCacheRoot(manifest, { cacheBase: dir, version: 'test' }),
      );
      for (const [relativePath, content] of Object.entries(PLUGIN_FILES)) {
        expect(readFileSync(join(pluginsDir ?? '', ...relativePath.split('/')), 'utf-8')).toBe(
          content,
        );
      }
      expect(existsSync(join(dir, 'bundled-plugins', 'test', 'test-target'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repairs corrupted extracted files on the next lookup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-bundled-plugins-repair-'));
    try {
      const { manifest, source } = fakeBundledPlugins(PLUGIN_FILES);

      const pluginsDir = getNativeBundledPluginsDir({
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });
      const manifestPath = join(pluginsDir ?? '', 'kimi-cu', 'kimi.plugin.json');
      writeFileSync(manifestPath, 'broken');

      const repairedDir = getNativeBundledPluginsDir({
        cacheBase: dir,
        manifest,
        source,
        version: 'test',
      });

      expect(repairedDir).toBe(pluginsDir);
      expect(readFileSync(manifestPath, 'utf-8')).toBe('{"name":"kimi-cu"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no SEA bundled-plugins source is available', () => {
    expect(getNativeBundledPluginsDir({ source: null })).toBeNull();
  });

  it('publishes the extracted directory through the engine env contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-bundled-plugins-publish-'));
    try {
      const { manifest, source } = fakeBundledPlugins(PLUGIN_FILES);
      const env: NodeJS.ProcessEnv = {};

      publishNativeBundledPluginsDir({ cacheBase: dir, manifest, source, version: 'test' }, env);

      const published = env[BUNDLED_PLUGINS_DIR_ENV];
      expect(published).toBe(
        getBundledPluginsCacheRoot(manifest, { cacheBase: dir, version: 'test' }),
      );
      // An explicit override (desktop extraResources, tests) always wins.
      const overrideEnv: NodeJS.ProcessEnv = { [BUNDLED_PLUGINS_DIR_ENV]: '/opt/custom' };
      publishNativeBundledPluginsDir(
        { cacheBase: dir, manifest, source, version: 'test' },
        overrideEnv,
      );
      expect(overrideEnv[BUNDLED_PLUGINS_DIR_ENV]).toBe('/opt/custom');
      // No SEA source → nothing published.
      const emptyEnv: NodeJS.ProcessEnv = {};
      publishNativeBundledPluginsDir({ source: null }, emptyEnv);
      expect(emptyEnv[BUNDLED_PLUGINS_DIR_ENV]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
