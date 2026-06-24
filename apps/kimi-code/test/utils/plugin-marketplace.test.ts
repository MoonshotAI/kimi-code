import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  KIMI_CODE_PLUGIN_MARKETPLACE_URL,
  KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV,
} from '#/constant/app';
import { computeUpdateStatus, loadPluginMarketplace } from '#/utils/plugin-marketplace';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('computeUpdateStatus', () => {
  it('reports not-installed when the plugin is absent', () => {
    expect(computeUpdateStatus('1.0.0', undefined, false)).toEqual({ kind: 'not-installed' });
  });

  it('reports an update when the marketplace version is newer', () => {
    expect(computeUpdateStatus('5.1.0', '5.0.0', true)).toEqual({
      kind: 'update',
      local: '5.0.0',
      latest: '5.1.0',
    });
  });

  it('reports up-to-date when versions match', () => {
    expect(computeUpdateStatus('5.1.0', '5.1.0', true)).toEqual({
      kind: 'up-to-date',
      version: '5.1.0',
    });
  });

  it('does not offer a downgrade when the local version is ahead', () => {
    expect(computeUpdateStatus('3.1.1', '3.2.0', true)).toEqual({
      kind: 'up-to-date',
      version: '3.2.0',
    });
  });

  it('never reports an update for non-semver versions', () => {
    expect(computeUpdateStatus('latest', '5.0.0', true).kind).toBe('up-to-date');
    expect(computeUpdateStatus('5.1.0', 'dev', true).kind).toBe('up-to-date');
  });

  it('shows the local version even when the marketplace omits one', () => {
    expect(computeUpdateStatus(undefined, '5.0.0', true)).toEqual({
      kind: 'up-to-date',
      version: '5.0.0',
    });
  });

  it('does not claim the marketplace version as installed when the local version is unknown', () => {
    // No spurious `installed · v<latest>`, and no permanent suppression of updates.
    expect(computeUpdateStatus('5.1.0', undefined, true)).toEqual({
      kind: 'up-to-date',
      version: undefined,
    });
  });
});

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
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return {
          status: 302,
          headers: new Headers({
            location: 'https://github.com/obra/superpowers/releases/tag/v6.0.3',
          }),
        } as Response;
      }
      return { status: 404, headers: new Headers() } as Response;
    }) as unknown as typeof fetch;
    const marketplace = await loadPluginMarketplace({
      workDir: REPO_ROOT,
      source: join(REPO_ROOT, 'plugins/marketplace.json'),
      fetchImpl,
    });

    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        id: 'superpowers',
        displayName: 'Superpowers',
        tier: 'curated',
        source: 'https://github.com/obra/superpowers',
        version: '6.0.3',
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

    const marketplace = await loadPluginMarketplace({
      workDir: '/tmp/work',
      source: KIMI_CODE_PLUGIN_MARKETPLACE_URL,
      fetchImpl,
    });

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

  it('falls back to the source checkout marketplace when the default CDN cannot be fetched', async () => {
    const previous = process.env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV];
    delete process.env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV];
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;

    try {
      const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', fetchImpl });

      expect(fetchImpl).toHaveBeenCalledWith(KIMI_CODE_PLUGIN_MARKETPLACE_URL);
      expect(marketplace.source).toBe(join(REPO_ROOT, 'plugins/marketplace.json'));
      expect(marketplace.plugins).toContainEqual(
        expect.objectContaining({
          id: 'superpowers',
          source: 'https://github.com/obra/superpowers',
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV];
      } else {
        process.env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV] = previous;
      }
    }
  });

  it('does not use the source checkout fallback for explicit marketplace sources', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;

    await expect(loadPluginMarketplace({
      workDir: '/tmp/work',
      source: KIMI_CODE_PLUGIN_MARKETPLACE_URL,
      fetchImpl,
    })).rejects.toThrow(/fetch failed/);
  });

  describe('version derivation from a GitHub source', () => {
    async function loadEntry(source: string, version?: string) {
      const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
      const file = join(dir, 'marketplace.json');
      await writeFile(
        file,
        JSON.stringify({
          plugins: [
            {
              id: 'demo',
              displayName: 'Demo',
              source,
              version,
            },
          ],
        }),
        'utf8',
      );
      const marketplace = await loadPluginMarketplace({ workDir: dir, source: file });
      return marketplace.plugins[0]!;
    }

    it('derives a version from a /releases/tag/ source', async () => {
      const entry = await loadEntry('https://github.com/obra/superpowers/releases/tag/v6.0.3');
      expect(entry.version).toBe('6.0.3');
    });

    it('derives a version from a /tree/ source', async () => {
      const entry = await loadEntry('https://github.com/obra/superpowers/tree/v6.0.3');
      expect(entry.version).toBe('6.0.3');
    });

    it('accepts a tag without a leading v', async () => {
      const entry = await loadEntry('https://github.com/obra/superpowers/releases/tag/6.0.3');
      expect(entry.version).toBe('6.0.3');
    });

    it('does not derive a version from a commit SHA', async () => {
      const entry = await loadEntry('https://github.com/obra/superpowers/commit/abc1234');
      expect(entry.version).toBeUndefined();
    });

    it('does not derive a version from a non-GitHub URL', async () => {
      const entry = await loadEntry('https://code.kimi.com/kimi-code/plugins/curated/superpowers.zip');
      expect(entry.version).toBeUndefined();
    });

    it('lets an explicit version override the derived one', async () => {
      const entry = await loadEntry(
        'https://github.com/obra/superpowers/releases/tag/v6.0.3',
        '9.9.9',
      );
      expect(entry.version).toBe('9.9.9');
    });
  });

  describe('latest release resolution for bare GitHub sources', () => {
    async function loadWithLatest(source: string, fetchImpl: typeof fetch) {
      const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
      const file = join(dir, 'marketplace.json');
      await writeFile(
        file,
        JSON.stringify({ plugins: [{ id: 'demo', displayName: 'Demo', source }] }),
        'utf8',
      );
      const marketplace = await loadPluginMarketplace({ workDir: dir, source: file, fetchImpl });
      return marketplace.plugins[0]!;
    }

    function redirectFetch(location: string): typeof fetch {
      return vi.fn(async () => ({
        status: 302,
        headers: new Headers({ location }),
      })) as unknown as typeof fetch;
    }

    it('fills the version from /releases/latest for a bare repo URL', async () => {
      const entry = await loadWithLatest(
        'https://github.com/owner/repo',
        redirectFetch('https://github.com/owner/repo/releases/tag/v6.0.3'),
      );
      expect(entry.version).toBe('6.0.3');
    });

    it('strips a leading v from the resolved latest tag', async () => {
      const entry = await loadWithLatest(
        'https://github.com/owner/repo',
        redirectFetch('https://github.com/owner/repo/releases/tag/6.0.3'),
      );
      expect(entry.version).toBe('6.0.3');
    });

    it('leaves version undefined when the repo has no release', async () => {
      const fetchImpl = vi.fn(async () => ({
        status: 404,
        headers: new Headers(),
      })) as unknown as typeof fetch;
      const entry = await loadWithLatest('https://github.com/owner/repo', fetchImpl);
      expect(entry.version).toBeUndefined();
    });

    it('degrades gracefully when the latest lookup throws', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch;
      const entry = await loadWithLatest('https://github.com/owner/repo', fetchImpl);
      expect(entry.version).toBeUndefined();
    });

    it('does not query latest when the source already pins a ref', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('should not be called');
      }) as unknown as typeof fetch;
      const entry = await loadWithLatest(
        'https://github.com/owner/repo/releases/tag/v6.0.3',
        fetchImpl,
      );
      expect(entry.version).toBe('6.0.3');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('keeps an explicit version without querying latest', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('should not be called');
      }) as unknown as typeof fetch;
      const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
      const file = join(dir, 'marketplace.json');
      await writeFile(
        file,
        JSON.stringify({
          plugins: [
            {
              id: 'demo',
              displayName: 'Demo',
              version: '9.9.9',
              source: 'https://github.com/owner/repo',
            },
          ],
        }),
        'utf8',
      );
      const marketplace = await loadPluginMarketplace({ workDir: dir, source: file, fetchImpl });
      expect(marketplace.plugins[0]?.version).toBe('9.9.9');
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it('accepts legacy marketplace type aliases as normal plugins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({
        plugins: [
          {
            id: 'kimi-webbridge',
            type: 'guide',
            displayName: 'Kimi WebBridge',
            source: './kimi-webbridge',
            installSkill: 'install',
            removeSkill: 'remove',
          },
          {
            id: 'demo-managed',
            type: 'managed',
            source: './demo-managed',
          },
        ],
      }),
      'utf8',
    );

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', source: file });

    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        id: 'kimi-webbridge',
        source: join(dir, 'kimi-webbridge'),
      }),
    );
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        id: 'demo-managed',
        source: join(dir, 'demo-managed'),
      }),
    );
  });

  it('rejects an entry without a source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({ plugins: [{ id: 'broken', displayName: 'Broken' }] }),
      'utf8',
    );

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /must define "source"/,
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

  it('rejects unknown marketplace entry types', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({
        plugins: [{ id: 'demo', type: 'integration', source: './demo' }],
      }),
      'utf8',
    );

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /Legacy aliases "managed" and "guide" are also accepted/,
    );
  });

});
