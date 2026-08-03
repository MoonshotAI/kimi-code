/**
 * Bundled wiring-plugin resolution — env override, explicit root override,
 * and the module-relative walk-up over the npm (`bundled-plugins/<id>`) and
 * source-checkout (`plugins/official/<id>`) layouts. Every candidate must
 * carry a `kimi.plugin.json` marker.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __bundledPluginsInternals,
  BUNDLED_PLUGINS_DIR_ENV,
  requireBundledPluginDir,
  resolveBundledPluginDir,
} from '#/app/capability/bundledPlugins';

const PLUGIN_ID = 'kimi-webbridge';

describe('bundled plugin resolution', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bundled-plugins-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makePluginDir(parent: string, id = PLUGIN_ID): Promise<string> {
    const dir = path.join(parent, id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'kimi.plugin.json'), '{}');
    return dir;
  }

  it('resolves the explicit root override when the marker exists', async () => {
    const dir = await makePluginDir(root);
    expect(resolveBundledPluginDir(PLUGIN_ID, root, {})).toBe(dir);
  });

  it('rejects a root override whose plugin dir lacks the manifest marker', async () => {
    await mkdir(path.join(root, PLUGIN_ID), { recursive: true });
    expect(resolveBundledPluginDir(PLUGIN_ID, root, {})).toBeUndefined();
  });

  it('resolves the env override and does not fall through when it is broken', async () => {
    const dir = await makePluginDir(root);
    const env = { [BUNDLED_PLUGINS_DIR_ENV]: root };
    expect(resolveBundledPluginDir(PLUGIN_ID, undefined, env)).toBe(dir);
    // A broken override must not silently fall back to another copy.
    const broken = { [BUNDLED_PLUGINS_DIR_ENV]: path.join(root, 'nope') };
    expect(resolveBundledPluginDir(PLUGIN_ID, undefined, broken)).toBeUndefined();
  });

  it('probes the npm package layout (bundled-plugins/<id>) walking up', async () => {
    const dir = await makePluginDir(path.join(root, 'bundled-plugins'));
    const startDir = path.join(root, 'dist');
    await mkdir(startDir, { recursive: true });
    expect(__bundledPluginsInternals.probeUpwards(startDir, PLUGIN_ID)).toBe(dir);
  });

  it('probes the source checkout layout (plugins/official/<id>) walking up', async () => {
    const dir = await makePluginDir(path.join(root, 'plugins', 'official'));
    const startDir = path.join(root, 'packages', 'agent-core-v2', 'src');
    await mkdir(startDir, { recursive: true });
    expect(__bundledPluginsInternals.probeUpwards(startDir, PLUGIN_ID)).toBe(dir);
  });

  it('prefers the npm layout over the source layout at the same ancestor', async () => {
    const npmDir = await makePluginDir(path.join(root, 'bundled-plugins'));
    await makePluginDir(path.join(root, 'plugins', 'official'));
    expect(__bundledPluginsInternals.probeUpwards(root, PLUGIN_ID)).toBe(npmDir);
  });

  it('returns undefined when no layout carries the plugin', async () => {
    const startDir = path.join(root, 'a', 'b');
    await mkdir(startDir, { recursive: true });
    expect(__bundledPluginsInternals.probeUpwards(startDir, PLUGIN_ID)).toBeUndefined();
  });

  it('requireBundledPluginDir throws a clear error when the bundle is missing', () => {
    expect(() => requireBundledPluginDir(PLUGIN_ID, path.join(root, 'nope'))).toThrow(
      /bundled "kimi-webbridge" plugin is missing/,
    );
  });
});
