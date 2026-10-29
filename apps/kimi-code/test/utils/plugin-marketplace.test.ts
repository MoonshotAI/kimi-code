import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { OAuthUnauthorizedError } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeUpdateStatus, loadPluginMarketplace, pluginMarketplaceCliDescription } from '#/utils/plugin-marketplace';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function catalogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    displayName: 'Demo',
    version: '1.0.0',
    description: 'Demo description',
    source: './demo.zip',
    sha256sum: 'a'.repeat(64),
    platforms: ['macos', 'windows', 'linux'],
    distribution: {
      category: 'third_party',
      region: 'all',
      defaultInstall: false,
      weight: 1,
    },
    ...overrides,
  };
}

async function writeCatalog(entries: readonly Record<string, unknown>[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-plugin-marketplace-'));
  const file = join(dir, 'marketplace.json');
  await writeFile(file, JSON.stringify({ plugins: entries }), 'utf8');
  return file;
}

function catalogFetch(entries: readonly Record<string, unknown>[]): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ plugins: entries }), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe('pluginMarketplaceCliDescription', () => {
  it('uses the top-level description when the default locale is English', () => {
    expect(pluginMarketplaceCliDescription({
      id: 'demo',
      displayName: 'Demo',
      source: 'demo.zip',
      cliDescription: 'Default English',
      locale: {
        defaultLocale: 'en-us',
        'en-us': { cliDescription: 'Translated English' },
      },
    })).toBe('Default English');
  });

  it('uses the English translation when the default locale is not English', () => {
    expect(pluginMarketplaceCliDescription({
      id: 'demo',
      displayName: 'Demo',
      source: 'demo.zip',
      cliDescription: '默认中文',
      locale: {
        defaultLocale: 'zh-cn',
        'en-us': { cliDescription: 'English translation' },
      },
    })).toBe('English translation');
  });

  it('does not use a non-English top-level description as an English translation', () => {
    expect(pluginMarketplaceCliDescription({
      id: 'demo',
      displayName: 'Demo',
      source: 'demo.zip',
      cliDescription: '默认中文',
      locale: { defaultLocale: 'zh-cn' },
    })).toBeUndefined();
  });

  it('keeps the top-level description when no locale metadata exists', () => {
    expect(pluginMarketplaceCliDescription({
      id: 'demo',
      displayName: 'Demo',
      source: 'demo.zip',
      cliDescription: 'Top description',
    })).toBe('Top description');
  });
});

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
    expect(computeUpdateStatus('latest', '5.0.0', true)).toEqual({
      kind: 'up-to-date',
      version: '5.0.0',
    });
    expect(computeUpdateStatus('5.1.0', 'dev', true)).toEqual({
      kind: 'up-to-date',
      version: 'dev',
    });
  });

  it('shows the local version even when the marketplace omits one', () => {
    expect(computeUpdateStatus(undefined, '5.0.0', true)).toEqual({
      kind: 'up-to-date',
      version: '5.0.0',
    });
  });

  it('does not claim the marketplace version as installed when the local version is unknown', () => {
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
        plugins: [
          catalogEntry({
            id: 'kimi-datasource',
            displayName: 'Kimi Datasource',
            source: './kimi-datasource.zip',
            distribution: { category: 'official', weight: 1 },
          }),
          catalogEntry({
            id: 'superpowers',
            displayName: 'Superpowers',
            source: './curated/superpowers.zip',
            homepage: 'https://example.test/superpowers',
            keywords: ['skills', 'workflow'],
          }),
          catalogEntry({ id: 'absolute', source: join(dir, 'absolute.zip') }),
          catalogEntry({
            id: 'file-url',
            source: pathToFileURL(join(dir, 'file-url.zip')).href,
          }),
        ],
      }),
      'utf8',
    );

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', source: file });

    expect(marketplace.source).toBe(file);
    expect(marketplace.plugins.map((entry) => [entry.id, entry.source])).toEqual([
      ['kimi-datasource', join(file, '..', 'kimi-datasource.zip')],
      ['superpowers', join(file, '..', 'curated/superpowers.zip')],
      ['absolute', join(file, '..', 'absolute.zip')],
      ['file-url', join(file, '..', 'file-url.zip')],
    ]);
    expect(marketplace.plugins[0]).toMatchObject({ classification: 'official', tier: 'official' });
    expect(marketplace.plugins[1]).toMatchObject({
      classification: 'third_party',
      tier: 'curated',
      homepage: 'https://example.test/superpowers',
      keywords: ['skills', 'workflow'],
    });
  });

  it('loads the default marketplace with injectable fetch and managed OAuth', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://api.example.test/coding/v1/');
    const fetchImpl = catalogFetch([catalogEntry()]);

    await loadPluginMarketplace({
      workDir: '/tmp/work',
      fetchImpl,
      getAccessToken: async () => 'managed-token',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.test/coding/v1/plugins/marketplace',
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer managed-token');
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
  });

  it('does not use the source checkout fallback for explicit marketplace sources', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;

    await expect(
      loadPluginMarketplace({
        workDir: '/tmp/work',
        source: 'https://example.test/marketplace.json',
        fetchImpl,
      }),
    ).rejects.toThrow('fetch failed');
  });

  it('rejects an entry without a source', async () => {
    const file = await writeCatalog([catalogEntry({ source: '   ' })]);

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /must define "source"/,
    );
  });

  it('loads an explicit remote marketplace with injectable fetch', async () => {
    const source = 'https://example.test/coding/v1/plugins/marketplace';
    const fetchImpl = catalogFetch([catalogEntry({ source: 'artifact.zip' })]);

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', source, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(source, undefined);
    expect(marketplace.plugins[0]?.source).toBe(new URL('artifact.zip', source).toString());
  });

  it('rejects malformed marketplace entries', async () => {
    const file = await writeCatalog([catalogEntry({ id: undefined })]);

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /must define "id"/,
    );
  });

  it('rejects unknown marketplace distribution categories', async () => {
    const file = await writeCatalog([catalogEntry({ distribution: { category: 'community' } })]);

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /"distribution.category" must be one of/,
    );
  });

  it('rejects unknown marketplace entry types and legacy type aliases', async () => {
    for (const type of ['integration', 'managed', 'guide']) {
      const file = await writeCatalog([catalogEntry({ type })]);
      await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
        /"type" must be "plugin"/,
      );
    }
    const valid = await writeCatalog([catalogEntry({ type: 'plugin' })]);
    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: valid })).resolves.toMatchObject({
      plugins: [expect.objectContaining({ id: 'demo' })],
    });
  });

  it('parses all codegw metadata without changing ordering or billing data', async () => {
    const file = await writeCatalog([
      catalogEntry({
        id: 'cloudbase',
        displayName: 'CloudBase',
        homepage: 'https://example.test/cloudbase',
        keywords: ['cloud', 'database'],
        iconUrl: 'https://example.test/icon.png',
        filename: 'cloudbase-1.0.0.zip',
        cliDescription: 'CLI description',
        locale: {
          defaultLocale: 'en-us',
          'zh-cn': {
            cliDescription: '命令行介绍',
            longDescription: '完整介绍',
            shortDescription: '短介绍',
          },
        },
        platforms: ['macos', 'cloud'],
        distribution: {
          category: 'official',
          region: 'all',
          defaultInstall: false,
          weight: 10,
          userLevel: { tier: 2 },
        },
        billing: { type: 'free' },
      }),
      catalogEntry({ id: 'second', distribution: { category: 'third_party', weight: 1 } }),
    ]);

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', source: file });

    expect(marketplace.plugins.map((entry) => entry.id)).toEqual(['cloudbase', 'second']);
    expect(marketplace.plugins[0]).toEqual({
      id: 'cloudbase',
      displayName: 'CloudBase',
      source: join(file, '..', 'demo.zip'),
      classification: 'official',
      tier: 'official',
      version: '1.0.0',
      description: 'Demo description',
      homepage: 'https://example.test/cloudbase',
      keywords: ['cloud', 'database'],
      iconUrl: 'https://example.test/icon.png',
      sha256sum: 'a'.repeat(64),
      filename: 'cloudbase-1.0.0.zip',
      cliDescription: 'CLI description',
      locale: {
        defaultLocale: 'en-us',
        'zh-cn': {
          cliDescription: '命令行介绍',
          longDescription: '完整介绍',
          shortDescription: '短介绍',
        },
      },
      platforms: ['darwin', 'cloud'],
      distribution: {
        category: 'official',
        region: 'all',
        defaultInstall: false,
        weight: 10,
        userLevel: { tier: 2 },
      },
      billing: { type: 'free' },
    });
  });

  it('accepts file URLs and preserves catalog order and weights', async () => {
    const file = await writeCatalog([
      catalogEntry({ id: 'first', distribution: { category: 'third_party', weight: 1 } }),
      catalogEntry({ id: 'second', distribution: { category: 'official', weight: 100 } }),
    ]);

    const marketplace = await loadPluginMarketplace({
      workDir: '/tmp/work',
      source: pathToFileURL(file).href,
    });

    expect(marketplace.plugins.map((entry) => [entry.id, entry.distribution?.weight])).toEqual([
      ['first', 1],
      ['second', 100],
    ]);
    expect(marketplace.plugins.map((entry) => entry.classification)).toEqual([
      'third_party',
      'official',
    ]);
  });

  it('allows anonymous default marketplace browsing without credentials', async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), 'kimi-empty-home-'));
    vi.stubEnv('KIMI_CODE_HOME', emptyHome);
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://api.example.test/coding/v1');
    const fetchImpl = catalogFetch([catalogEntry()]);

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', fetchImpl });

    expect(marketplace.plugins).toHaveLength(1);
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
  });

  it('does not fall back to the source checkout when the default catalog fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;

    await expect(
      loadPluginMarketplace({
        workDir: '/tmp/work',
        fetchImpl,
        getAccessToken: async () => 'managed-token',
      }),
    ).rejects.toThrow('fetch failed');
  });

  it('rejects legacy field aliases instead of reading them', async () => {
    const file = await writeCatalog([
      {
        id: 'legacy',
        name: 'Legacy',
        url: './legacy.zip',
        tier: 'official',
        version: '1.0.0',
        sha256sum: 'a'.repeat(64),
        platforms: ['linux'],
        distribution: { category: 'official' },
      },
    ]);

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /must define "displayName"/,
    );
  });

  it('requires sha256sum and distribution for every entry', async () => {
    const missingDigest = await writeCatalog([catalogEntry({ sha256sum: undefined })]);
    await expect(
      loadPluginMarketplace({ workDir: '/tmp/work', source: missingDigest }),
    ).rejects.toThrow(/must define "sha256sum"/);

    const missingDistribution = await writeCatalog([catalogEntry({ distribution: undefined })]);
    await expect(
      loadPluginMarketplace({ workDir: '/tmp/work', source: missingDistribution }),
    ).rejects.toThrow(/must define "distribution"/);
  });

  it('rejects an invalid SHA-256 digest', async () => {
    const file = await writeCatalog([catalogEntry({ sha256sum: 'invalid' })]);

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /SHA-256 hex digest/,
    );
  });

  it('rejects unsupported marketplace platforms', async () => {
    const file = await writeCatalog([catalogEntry({ platforms: ['freebsd'] })]);

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /"platforms" must contain only/,
    );
  });

  it('rejects malformed locale blocks', async () => {
    const file = await writeCatalog([catalogEntry({ locale: { 'zh-cn': 'invalid' } })]);

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /locale "zh-cn" must be an object/,
    );
  });

  it('does not retry catalog HTTP 401 or 403 anonymously', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
      await expect(
        loadPluginMarketplace({
          workDir: '/tmp/work',
          fetchImpl,
          getAccessToken: async () => 'managed-token',
        }),
      ).rejects.toThrow(`Plugin marketplace returned HTTP ${status}`);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('does not hide OAuth refresh failures as anonymous access', async () => {
    const fetchImpl = catalogFetch([catalogEntry()]);
    const failure = new OAuthUnauthorizedError(
      'Stored token for "kimi-code" was rejected; re-login required.',
    );

    await expect(
      loadPluginMarketplace({
        workDir: '/tmp/work',
        fetchImpl,
        getAccessToken: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
