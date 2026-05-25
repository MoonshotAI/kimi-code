import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { KimiCore } from '../../src/rpc/core-impl';

describe('KimiCore plugin RPCs', () => {
  it('install → list → setEnabled → remove round trip', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    const pluginRoot = await mkdtemp(path.join(tmpdir(), 'plugin-'));
    await mkdir(path.join(pluginRoot, '.kimi-plugin'), { recursive: true });
    await writeFile(
      path.join(pluginRoot, '.kimi-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'utf8',
    );

    const core = new KimiCore(async () => ({}) as never, { homeDir: home });
    await new Promise((r) => setImmediate(r));

    const installed = await core.installPlugin({ root: pluginRoot });
    expect(installed.id).toBe('demo');
    expect(installed.version).toBe('1.0.0');

    const list = core.listPlugins({});
    expect(list).toHaveLength(1);

    await core.setPluginEnabled({ id: 'demo', enabled: false });
    const after = core.listPlugins({});
    expect(after[0]?.enabled).toBe(false);

    await core.removePlugin({ id: 'demo' });
    expect(core.listPlugins({})).toEqual([]);
  });
});
