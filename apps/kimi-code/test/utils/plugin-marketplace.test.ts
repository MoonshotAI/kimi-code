import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { KIMI_CODE_PLUGIN_MARKETPLACE_URL } from '#/constant/app';
import { loadPluginMarketplace } from '#/utils/plugin-marketplace';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('loadPluginMarketplace', () => {
  it('loads a local marketplace file and resolves relative plugin sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({
        version: '1',
        plugins: [
          {
            id: 'kimi-datasource',
            tier: 'official',
            displayName: 'Kimi Datasource',
            version: '1.0.0',
            description: 'Datasource tools',
            source: './kimi-datasource',
            keywords: ['data'],
          },
          {
            id: 'superpowers',
            tier: 'curated',
            displayName: 'Superpowers',
            version: '5.1.0',
            description: 'Workflow skills',
            homepage: 'https://github.com/obra/superpowers',
            source: './curated/superpowers',
            keywords: ['skills', 'workflow'],
          },
        ],
      }),
      'utf8',
    );

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', source: file });

    expect(marketplace).toEqual({
      source: file,
      version: '1',
      plugins: [
        {
          id: 'kimi-datasource',
          displayName: 'Kimi Datasource',
          tier: 'official',
          version: '1.0.0',
          description: 'Datasource tools',
          source: join(dir, 'kimi-datasource'),
          keywords: ['data'],
          homepage: undefined,
        },
        {
          id: 'superpowers',
          displayName: 'Superpowers',
          tier: 'curated',
          version: '5.1.0',
          description: 'Workflow skills',
          source: join(dir, 'curated', 'superpowers'),
          keywords: ['skills', 'workflow'],
          homepage: 'https://github.com/obra/superpowers',
        },
      ],
    });
  });

  it('includes Superpowers in the repository marketplace fixture', async () => {
    const marketplace = await loadPluginMarketplace({
      workDir: REPO_ROOT,
      source: join(REPO_ROOT, 'plugins/marketplace.json'),
    });

    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        id: 'superpowers',
        displayName: 'Superpowers',
        tier: 'curated',
        source: join(REPO_ROOT, 'plugins/curated/superpowers'),
      }),
    );
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        id: 'kimi-datasource',
        tier: 'official',
        source: join(REPO_ROOT, 'plugins/official/kimi-datasource'),
      }),
    );
  });

  it('loads the default CDN marketplace with injectable fetch', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          plugins: [
            {
              id: 'kimi-datasource',
              displayName: 'Kimi Datasource',
              source: './official/kimi-datasource.zip',
            },
          ],
        }),
    })) as unknown as typeof fetch;

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(KIMI_CODE_PLUGIN_MARKETPLACE_URL);
    expect(marketplace.plugins[0]).toEqual(
      expect.objectContaining({
        id: 'kimi-datasource',
        displayName: 'Kimi Datasource',
        source: new URL(
          './official/kimi-datasource.zip',
          KIMI_CODE_PLUGIN_MARKETPLACE_URL,
        ).toString(),
      }),
    );
  });

  it('loads an explicit remote marketplace with injectable fetch', async () => {
    const source = 'https://example.com/plugins/marketplace.json';
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          plugins: [{ id: 'superpowers', name: 'Superpowers', url: 'superpowers.zip' }],
        }),
    })) as unknown as typeof fetch;

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', source, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(source);
    expect(marketplace.plugins[0]).toEqual(
      expect.objectContaining({
        id: 'superpowers',
        displayName: 'Superpowers',
        source: new URL('superpowers.zip', source).toString(),
      }),
    );
  });

  it('rejects malformed marketplace entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(file, JSON.stringify({ plugins: [{ displayName: 'Missing id' }] }), 'utf8');

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /must define "id"/,
    );
  });

  it('rejects unknown marketplace tier values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({
        plugins: [{ id: 'demo', tier: 'community', source: './demo' }],
      }),
      'utf8',
    );

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /"tier" must be one of/,
    );
  });
});
