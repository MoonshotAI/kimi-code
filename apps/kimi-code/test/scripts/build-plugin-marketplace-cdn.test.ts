import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildPluginMarketplaceCdn } from '../../scripts/build-plugin-marketplace-cdn.mjs';

async function writeMarketplace(dir: string, plugins: readonly unknown[]): Promise<void> {
  await writeFile(join(dir, 'marketplace.json'), JSON.stringify({ version: '1', plugins }), 'utf8');
}

async function readOutput(dir: string): Promise<{ plugins: readonly Record<string, unknown>[] }> {
  return JSON.parse(await readFile(join(dir, 'marketplace.json'), 'utf8')) as {
    plugins: readonly Record<string, unknown>[];
  };
}

describe('buildPluginMarketplaceCdn', () => {
  it('stamps a derived version for a pinned GitHub release source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cdn-src-'));
    const out = await mkdtemp(join(tmpdir(), 'cdn-out-'));
    await writeMarketplace(root, [
      {
        id: 'superpowers',
        tier: 'curated',
        displayName: 'Superpowers',
        source: 'https://github.com/obra/superpowers/releases/tag/v6.0.3',
      },
    ]);

    await buildPluginMarketplaceCdn({ pluginsRoot: root, outDir: out });
    const output = await readOutput(out);

    expect(output.plugins[0]).toMatchObject({
      id: 'superpowers',
      source: 'https://github.com/obra/superpowers/releases/tag/v6.0.3',
      version: '6.0.3',
    });
  });

  it('derives a version from a /tree/ source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cdn-src-'));
    const out = await mkdtemp(join(tmpdir(), 'cdn-out-'));
    await writeMarketplace(root, [
      {
        id: 'demo',
        displayName: 'Demo',
        source: 'https://github.com/owner/repo/tree/v1.2.3',
      },
    ]);

    await buildPluginMarketplaceCdn({ pluginsRoot: root, outDir: out });
    const output = await readOutput(out);

    expect(output.plugins[0]).toMatchObject({ version: '1.2.3' });
  });

  it('does not stamp a version for a bare GitHub URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cdn-src-'));
    const out = await mkdtemp(join(tmpdir(), 'cdn-out-'));
    await writeMarketplace(root, [
      {
        id: 'demo',
        displayName: 'Demo',
        source: 'https://github.com/owner/repo',
      },
    ]);

    await buildPluginMarketplaceCdn({ pluginsRoot: root, outDir: out });
    const output = await readOutput(out);

    expect(output.plugins[0]?.['version']).toBeUndefined();
  });

  it('keeps an explicit version over a derived one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cdn-src-'));
    const out = await mkdtemp(join(tmpdir(), 'cdn-out-'));
    await writeMarketplace(root, [
      {
        id: 'demo',
        displayName: 'Demo',
        version: '9.9.9',
        source: 'https://github.com/owner/repo/releases/tag/v1.2.3',
      },
    ]);

    await buildPluginMarketplaceCdn({ pluginsRoot: root, outDir: out });
    const output = await readOutput(out);

    expect(output.plugins[0]?.['version']).toBe('9.9.9');
  });
});
