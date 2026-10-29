import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPluginMarketplaceCdn } from '../../scripts/build-plugin-marketplace-cdn.mjs';
import { startPluginMarketplaceServer } from '../../scripts/dev-plugin-marketplace-server.mjs';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('buildPluginMarketplaceCdn', () => {
  it('packages only plugins listed in the marketplace catalog', async () => {
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
        plugins: [
          {
            id: 'listed-plugin',
            version: '1.0.0',
            source: './official/listed-plugin',
            platforms: ['macos'],
            distribution: { category: 'official', region: 'all', defaultInstall: false, weight: 1 },
            billing: 'free',
          },
        ],
      }),
      'utf8',
    );

    await buildPluginMarketplaceCdn({ pluginsRoot, outDir });

    await expect(access(join(outDir, 'official/listed-plugin.zip'))).resolves.toBeUndefined();
    await expect(access(join(outDir, 'official/kimi-webbridge.zip'))).rejects.toThrow();
    await expect(access(join(outDir, 'official/not-listed.zip'))).rejects.toThrow();
    const marketplace = JSON.parse(await readFile(join(outDir, 'marketplace.json'), 'utf8'));
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].id).toBe('listed-plugin');
    expect(marketplace.plugins[0].version).toBe('1.0.0');
    const archive = await readFile(join(outDir, 'official/listed-plugin.zip'));
    expect(marketplace.plugins[0].sha256sum).toBe(
      createHash('sha256').update(archive).digest('hex'),
    );
  });

  it('serves a new protocol catalog and matching ZIP digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-plugin-dev-server-'));
    tempRoots.push(root);
    const pluginsRoot = join(root, 'plugins');
    await writePlugin(pluginsRoot, 'kimi-webbridge', 'kimi-browser-extension');
    await writeFile(
      join(pluginsRoot, 'marketplace.json'),
      JSON.stringify({
        version: '1',
        plugins: [
          {
            id: 'kimi-browser-extension',
            version: '2.0.22',
            source: './official/kimi-webbridge',
            platforms: ['macos'],
            distribution: { category: 'official', region: 'all', defaultInstall: false, weight: 1 },
            billing: 'free',
          },
        ],
      }),
      'utf8',
    );
    const started = await startPluginMarketplaceServer({ pluginsRoot });

    try {
      const response = await fetch(started.marketplaceUrl);
      expect(response.status).toBe(200);
      const catalog = (await response.json()) as {
        plugins: Array<{ id: string; version: string; source: string; sha256sum: string }>;
      };
      const entry = catalog.plugins[0]!;
      expect(entry.id).toBe('kimi-browser-extension');
      expect(entry.version).toBe('1.0.0');
      const zipResponse = await fetch(new URL(entry.source, started.marketplaceUrl));
      expect(zipResponse.status).toBe(200);
      const bytes = Buffer.from(await zipResponse.arrayBuffer());
      expect(entry.sha256sum).toBe(createHash('sha256').update(bytes).digest('hex'));
    } finally {
      await started.close();
    }
  });
});

async function writePlugin(pluginsRoot: string, id: string, manifestId = id): Promise<void> {
  const pluginDir = join(pluginsRoot, 'official', id);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, 'kimi.plugin.json'),
    JSON.stringify({ name: manifestId, version: '1.0.0' }),
    'utf8',
  );
}
