import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders, bearerToken } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

const CATALOG_URL = 'http://marketplace.test/marketplace.json';

const CATALOG = {
  version: '1',
  plugins: [
    {
      id: 'demo-plugin',
      tier: 'official',
      displayName: 'Demo Plugin',
      version: 'v2.0.0',
      source: 'https://cdn.example.test/demo.zip',
    },
    {
      id: 'third-party-plugin',
      displayName: 'Third Party',
      source: 'https://github.com/example/third',
    },
    {
      id: 'relative-plugin',
      displayName: 'Relative',
      source: './plugins/relative.zip',
    },
    {
      id: 'alias-plugin',
      displayName: 'Alias',
      source: '   ',
      url: './plugins/alias.zip',
    },
    {
      id: 'blank-tier-plugin',
      displayName: 'Blank Tier',
      tier: '  ',
      source: 'https://example.test/bt.zip',
    },
    {
      id: 'gh-plugin',
      displayName: 'GH Plugin',
      version: 2,
      source: 'https://github.com/example/gh/releases/tag/v2.0.0',
    },
    {
      id: 'kimi-webbridge',
      displayName: 'Kimi WebBridge',
      source: 'https://cdn.example.test/kimi-webbridge.zip',
    },
    {
      id: 'kimi-cu',
      displayName: 'Kimi Computer Use',
      source: 'https://cdn.example.test/kimi-cu.zip',
    },
    {
      id: '  meta-alias-plugin  ',
      name: 'Meta Alias',
      shortDescription: 'Aliased metadata',
      websiteURL: 'https://example.test/meta',
      keywords: ['web', 3, '  ', 'tools'],
      source: 'https://example.test/meta.zip',
    },
  ],
};

describe('server-v2 /api/v1 plugins', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  const createdDirs: string[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-plugins-'));
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url === CATALOG_URL) {
          return new Response(JSON.stringify(CATALOG), { status: 200 });
        }
        if (url === 'https://github.com/example/third/releases/latest') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://github.com/example/third/releases/tag/v3.1.0' },
          });
        }
        if (typeof url === 'string' && url.includes('/releases/latest')) {
          return new Response(null, { status: 404 });
        }
        return realFetch(url as never, init);
      }),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      pluginMarketplaceUrl: CATALOG_URL,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function makePluginDir(id: string, version: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `kimi-test-plugin-${id}-`));
    createdDirs.push(dir);
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({ name: id, version, description: 'test plugin' }),
    );
    return dir;
  }

  it('installs, lists, disables, enables, and removes a plugin', async () => {
    const empty = await call<{ plugins: unknown[] }>('GET', '/api/v1/plugins');
    expect(empty.body.data.plugins).toEqual([]);

    const source = await makePluginDir('demo-plugin', '1.0.0');
    const installed = await call<{ id: string; version: string; enabled: boolean }>(
      'POST',
      '/api/v1/plugins',
      { source },
    );
    expect(installed.body.code).toBe(0);
    expect(installed.body.data).toMatchObject({ id: 'demo-plugin', version: '1.0.0', enabled: true });

    const list = await call<{ plugins: { id: string; enabled: boolean }[] }>(
      'GET',
      '/api/v1/plugins',
    );
    expect(list.body.data.plugins.map((p) => [p.id, p.enabled])).toEqual([['demo-plugin', true]]);

    const disabled = await call<{ ok: true }>('POST', '/api/v1/plugins/demo-plugin:disable');
    expect(disabled.body.code).toBe(0);
    const afterDisable = await call<{ plugins: { enabled: boolean }[] }>('GET', '/api/v1/plugins');
    expect(afterDisable.body.data.plugins[0]?.enabled).toBe(false);

    const enabled = await call<{ ok: true }>('POST', '/api/v1/plugins/demo-plugin:enable');
    expect(enabled.body.code).toBe(0);

    const removed = await call<{ ok: true }>('POST', '/api/v1/plugins/demo-plugin:remove');
    expect(removed.body.code).toBe(0);
    const afterRemove = await call<{ plugins: unknown[] }>('GET', '/api/v1/plugins');
    expect(afterRemove.body.data.plugins).toEqual([]);
  });

  it('rejects bare ids, bogus actions, and unknown plugins', async () => {
    const bare = await call('POST', '/api/v1/plugins/demo-plugin');
    expect(bare.body.code).toBe(40001);
    const bogus = await call('POST', '/api/v1/plugins/demo-plugin:explode');
    expect(bogus.body.code).toBe(40001);
    const unknown = await call('POST', '/api/v1/plugins/nope:remove');
    expect(unknown.body.code).toBe(40419);
    const badSource = await call('POST', '/api/v1/plugins', { source: '' });
    expect(badSource.body.code).toBe(40001);
  });

  it('fans out event.plugin.changed over WS on install and remove', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/ws`, [
      `kimi-code.bearer.${bearerToken(server!)}`,
    ]);
    const types: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('message', () => {
          resolve();
        });
        ws.once('error', reject);
      });
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString('utf8')) as { type?: string };
        if (frame.type !== undefined) types.push(frame.type);
      });

      const source = await makePluginDir('demo-plugin', '1.0.0');
      await call('POST', '/api/v1/plugins', { source });
      await vi.waitFor(() => {
        expect(types).toContain('event.plugin.changed');
      });

      await call('POST', '/api/v1/plugins/demo-plugin:remove');
      await vi.waitFor(() => {
        expect(types.filter((t) => t === 'event.plugin.changed').length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      ws.close();
    }
  });

  it('maps client-fixable install input errors to 4xx, never 50001', async () => {
    const relative = await call('POST', '/api/v1/plugins', { source: 'relative/dir' });
    expect(relative.body.code).toBe(40001);
    const missing = await call('POST', '/api/v1/plugins', {
      source: join(home!, 'no-such-plugin-dir'),
    });
    expect(missing.body.code).toBe(40409);
    const noManifest = await mkdtemp(join(tmpdir(), 'kimi-no-manifest-'));
    createdDirs.push(noManifest);
    const unloadable = await call('POST', '/api/v1/plugins', { source: noManifest });
    expect(unloadable.body.code).toBe(40001);
  });

  it('serves the marketplace catalog merged with live install state', async () => {
    const before = await call<{
      entries: {
        id: string;
        tier: string;
        displayName: string;
        source: string;
        version?: string;
        capabilityId?: string;
        description?: string;
        homepage?: string;
        keywords?: string[];
        installed?: { version?: string };
      }[];
    }>('GET', '/api/v1/plugins/marketplace');
    expect(before.body.code).toBe(0);
    expect(before.body.data.entries.map((e) => [e.id, e.tier])).toEqual([
      ['demo-plugin', 'official'],
      ['third-party-plugin', 'third-party'],
      ['relative-plugin', 'third-party'],
      ['alias-plugin', 'third-party'],
      ['blank-tier-plugin', 'third-party'],
      ['gh-plugin', 'third-party'],
      ['kimi-webbridge', 'third-party'],
      ['kimi-cu', 'third-party'],
      ['meta-alias-plugin', 'third-party'],
    ]);
    expect(before.body.data.entries[0]?.installed).toBeUndefined();
    const relative = before.body.data.entries.find((e) => e.id === 'relative-plugin');
    expect(relative?.source).toBe('http://marketplace.test/plugins/relative.zip');
    const alias = before.body.data.entries.find((e) => e.id === 'alias-plugin');
    expect(alias?.source).toBe('http://marketplace.test/plugins/alias.zip');
    expect(before.body.data.entries.find((e) => e.id === 'gh-plugin')?.version).toBe('2.0.0');
    expect(before.body.data.entries.find((e) => e.id === 'third-party-plugin')?.version).toBe(
      '3.1.0',
    );
    expect(
      before.body.data.entries.find((e) => e.id === 'kimi-webbridge')?.capabilityId,
    ).toBeUndefined();
    expect(before.body.data.entries.some((e) => e.source.startsWith('capability:'))).toBe(false);
    const meta = before.body.data.entries.find((e) => e.id === 'meta-alias-plugin');
    expect(meta?.displayName).toBe('Meta Alias');
    expect(meta?.description).toBe('Aliased metadata');
    expect(meta?.homepage).toBe('https://example.test/meta');
    expect(meta?.keywords).toEqual(['web', 'tools']);

    const source = await makePluginDir('demo-plugin', '1.0.0');
    await call('POST', '/api/v1/plugins', { source });

    const after = await call<{
      entries: {
        id: string;
        installed?: { version?: string; enabled: boolean };
        updateAvailable?: boolean;
      }[];
    }>('GET', '/api/v1/plugins/marketplace');
    const demo = after.body.data.entries.find((e) => e.id === 'demo-plugin');
    expect(demo?.installed).toEqual({ version: '1.0.0', enabled: true });
    expect(demo?.updateAvailable).toBe(true);

    const ghSource = await makePluginDir('gh-plugin', '1.5.0');
    await call('POST', '/api/v1/plugins', { source: ghSource });
    const afterGh = await call<{
      entries: { id: string; updateAvailable?: boolean }[];
    }>('GET', '/api/v1/plugins/marketplace');
    expect(afterGh.body.data.entries.find((e) => e.id === 'gh-plugin')?.updateAvailable).toBe(true);
  });

  it('rejects a catalog whose entry has no usable source', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url === CATALOG_URL) {
          return new Response(
            JSON.stringify({ plugins: [{ id: 'bad', source: '   ' }] }),
            { status: 200 },
          );
        }
        return realFetch(url as never, init);
      }),
    );
    const { body } = await call('GET', '/api/v1/plugins/marketplace');
    expect(body.code).toBe(50001);
    expect(body.msg).toContain('invalid catalog');
  });

  it('rejects a catalog with an unsupported entry type', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url === CATALOG_URL) {
          return new Response(
            JSON.stringify({
              plugins: [{ id: 'bad', type: 'integration', source: 'https://example.test/x.zip' }],
            }),
            { status: 200 },
          );
        }
        return realFetch(url as never, init);
      }),
    );
    const { body } = await call('GET', '/api/v1/plugins/marketplace');
    expect(body.code).toBe(50001);
    expect(body.msg).toContain('invalid catalog');
  });

  it('treats the dev marketplace server as the default catalog', async () => {
    await server?.close();
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', CATALOG_URL);
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_FROM_DEV_SERVER', '1');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const { body } = await call<{ entries: { id: string; capabilityId?: string }[] }>(
      'GET',
      '/api/v1/plugins/marketplace',
    );
    expect(body.code).toBe(0);
    expect(body.data.entries.find((e) => e.id === 'kimi-webbridge')?.capabilityId).toBe(
      'kimi-webbridge',
    );

    const cuSupported = process.platform === 'darwin' || (process.platform === 'win32' && process.arch === 'x64');
    const after0 = await call<{
      entries: { id: string; capabilityId?: string; installed?: { version?: string } }[];
    }>('GET', '/api/v1/plugins/marketplace');
    if (!cuSupported) {
      expect(after0.body.data.entries.find((e) => e.id === 'kimi-cu')).toBeUndefined();
      return;
    }

    const winSource = await makePluginDir('kimi-cu-win', '0.5.4');
    await call('POST', '/api/v1/plugins', { source: winSource });
    const after = await call<{
      entries: { id: string; capabilityId?: string; installed?: { version?: string } }[];
    }>('GET', '/api/v1/plugins/marketplace');
    const cu = after.body.data.entries.find((e) => e.id === 'kimi-cu');
    expect(cu?.capabilityId).toBe('kimi-cu');
    expect(cu?.installed?.version).toBe('0.5.4');

    const staleSource = await makePluginDir('kimi-cu', '0.1.0');
    await call('POST', '/api/v1/plugins', { source: staleSource });
    const both = await call<{
      entries: { id: string; installed?: { version?: string } }[];
    }>('GET', '/api/v1/plugins/marketplace');
    const expected = process.platform === 'win32' && process.arch === 'x64' ? '0.5.4' : '0.1.0';
    expect(both.body.data.entries.find((e) => e.id === 'kimi-cu')?.installed?.version).toBe(
      expected,
    );
  });

  it('maps an unreachable marketplace to 50001', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (url === CATALOG_URL) {
          throw new Error('network down');
        }
        return realFetch(url as never, init);
      }),
    );
    const { body } = await call('GET', '/api/v1/plugins/marketplace');
    expect(body.code).toBe(50001);
    expect(body.msg).toContain('unreachable');
  });

  it('reads a local marketplace catalog from disk (plain path or file://)', async () => {
    await server?.close();
    const catalogDir = await mkdtemp(join(tmpdir(), 'kimi-local-catalog-'));
    createdDirs.push(catalogDir);
    const fileUrlPluginPath = join(catalogDir, 'plugins', 'file.zip');
    await writeFile(
      join(catalogDir, 'marketplace.json'),
      JSON.stringify({
        plugins: [
          { id: 'local-plugin', source: './zips/local.zip' },
          { id: 'file-url-plugin', source: pathToFileURL(fileUrlPluginPath).href },
        ],
      }),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
      pluginMarketplaceUrl: join(catalogDir, 'marketplace.json'),
    });
    base = `http://127.0.0.1:${server.port}`;

    const { body } = await call<{ entries: { id: string; source: string }[] }>(
      'GET',
      '/api/v1/plugins/marketplace',
    );
    expect(body.code).toBe(0);
    expect(body.data.entries).toEqual([
      {
        id: 'local-plugin',
        tier: 'third-party',
        displayName: 'local-plugin',
        source: join(catalogDir, 'zips', 'local.zip'),
      },
      {
        id: 'file-url-plugin',
        tier: 'third-party',
        displayName: 'file-url-plugin',
        source: fileUrlPluginPath,
      },
    ]);
  });

  it('falls back to the source-checkout catalog when the remote is unreachable', async () => {
    await server?.close();
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/releases/latest')) {
          return new Response(null, { status: 404 });
        }
        if (url === 'https://code.kimi.com/kimi-code/plugins/marketplace.json') {
          throw new Error('offline');
        }
        return realFetch(url as never, init);
      }),
    );
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', undefined as unknown as string);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const { body } = await call<{
      entries: {
        id: string;
        source: string;
        tier?: string;
        displayName?: string;
        capabilityId?: string;
      }[];
    }>('GET', '/api/v1/plugins/marketplace');
    expect(body.code).toBe(0);
    const datasource = body.data.entries.find((e) => e.id === 'kimi-datasource');
    expect(datasource?.source.startsWith('http')).toBe(false);
    expect(datasource?.source.endsWith(join('plugins', 'official', 'kimi-datasource'))).toBe(true);
    const webbridge = body.data.entries.find((e) => e.id === 'kimi-webbridge');
    expect(webbridge?.capabilityId).toBe('kimi-webbridge');
    const cuSupported = process.platform === 'darwin' || (process.platform === 'win32' && process.arch === 'x64');
    const cu = body.data.entries.find((e) => e.id === 'kimi-cu');
    if (!cuSupported) {
      expect(cu).toBeUndefined();
      return;
    }
    expect(cu?.tier).toBe('official');
    expect(cu?.capabilityId).toBe('kimi-cu');
    expect(cu?.source).toBe('capability:kimi-cu');
    expect(cu?.displayName).toBe('Kimi Computer Use');

    const cuSource = await makePluginDir('kimi-cu', '0.5.8');
    await call('POST', '/api/v1/plugins', { source: cuSource });
    const after = await call<{
      entries: { id: string; installed?: { version?: string; enabled: boolean } }[];
    }>('GET', '/api/v1/plugins/marketplace');
    expect(after.body.data.entries.find((e) => e.id === 'kimi-cu')?.installed).toEqual({
      version: '0.5.8',
      enabled: true,
    });
  });

  it('expands ~ in local catalog paths like the CLI loader', async () => {
    await server?.close();
    const fakeHome = await mkdtemp(join(tmpdir(), 'kimi-tilde-home-'));
    createdDirs.push(fakeHome);
    await writeFile(
      join(fakeHome, 'marketplace.json'),
      JSON.stringify({
        plugins: [
          { id: 'tilde-plugin', source: 'https://example.test/t.zip' },
          { id: 'tilde-entry-plugin', source: '~/plugins/t.zip' },
        ],
      }),
    );
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
      pluginMarketplaceUrl: '~/marketplace.json',
    });
    base = `http://127.0.0.1:${server.port}`;

    const { body } = await call<{ entries: { id: string; source: string }[] }>(
      'GET',
      '/api/v1/plugins/marketplace',
    );
    expect(body.code).toBe(0);
    expect(body.data.entries.map((e) => e.id)).toEqual(['tilde-plugin', 'tilde-entry-plugin']);
    expect(body.data.entries[1]?.source).toBe(join(fakeHome, 'plugins', 't.zip'));
  });
});
