import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPluginMarketplaceCdn } from '../../scripts/build-plugin-marketplace-cdn.mjs';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('buildPluginMarketplaceCdn', () => {
  it('packages WebBridge without publishing other unlisted official directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-plugin-cdn-build-'));
    tempRoots.push(root);
    const pluginsRoot = join(root, 'plugins');
    const outDir = join(root, 'out');

    await writePlugin(pluginsRoot, 'listed-plugin');
    await writePlugin(pluginsRoot, 'kimi-webbridge');
    await writePlugin(pluginsRoot, 'not-listed');
    await writeFile(
      join(pluginsRoot, 'marketplace.json'),
      JSON.stringify({
        version: '1',
        plugins: [{ id: 'listed-plugin', source: './official/listed-plugin' }],
      }),
      'utf8',
    );

    await buildPluginMarketplaceCdn({ pluginsRoot, outDir });

    await expect(access(join(outDir, 'official/listed-plugin.zip'))).resolves.toBeUndefined();
    await expect(access(join(outDir, 'official/kimi-webbridge.zip'))).resolves.toBeUndefined();
    await expect(access(join(outDir, 'official/not-listed.zip'))).rejects.toThrow();
    const marketplace = JSON.parse(await readFile(join(outDir, 'marketplace.json'), 'utf8'));
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].id).toBe('listed-plugin');
  });
});

async function writePlugin(pluginsRoot: string, id: string): Promise<void> {
  const pluginDir = join(pluginsRoot, 'official', id);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, 'kimi.plugin.json'),
    JSON.stringify({ name: id, version: '1.0.0' }),
    'utf8',
  );
}
