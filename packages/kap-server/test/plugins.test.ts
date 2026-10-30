import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { IPluginMarketplaceService, IPluginService } from '@moonshot-ai/agent-core-v2';
import {
  KIMI_CODE_PROVIDER_NAME,
  KIMI_REGION_PROFILES,
  KimiOAuthToolkit,
  OAuthUnauthorizedError,
  resolveKimiCodeOAuthRef,
} from '@moonshot-ai/kimi-code-oauth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders, bearerToken } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

const CATALOG_URL = 'http://marketplace.test/marketplace.json';
const DEFAULT_CATALOG_URL = 'http://marketplace.test/coding/v1/plugins/marketplace';
const GLOBAL_CATALOG_URL = `${KIMI_REGION_PROFILES.global.baseUrl}/plugins/marketplace`;

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function catalogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo-plugin',
    displayName: 'Demo Plugin',
    version: '2.0.0',
    description: 'Demo description',
    homepage: 'https://example.test/demo',
    keywords: ['demo'],
    source: 'https://cdn.example.test/demo.zip',
    iconUrl: 'https://example.test/demo.png',
    sha256sum: 'a'.repeat(64),
    filename: 'demo-2.0.0.zip',
    cliDescription: 'Demo CLI description',
    platforms: ['macos', 'windows', 'linux'],
    distribution: {
      category: 'third_party',
      region: 'all',
      defaultInstall: false,
      weight: 1,
    },
    billing: 'free',
    ...overrides,
  };
}

function createCatalog(): { plugins: Array<Record<string, unknown>> } {
  return {
    plugins: [
      catalogEntry({
        distribution: { category: 'official', region: 'all', defaultInstall: false, weight: 100 },
      }),
      catalogEntry({
        id: 'third-party-plugin',
        displayName: 'Third Party',
        version: '3.1.0',
        source: 'https://cdn.example.test/third.zip',
      }),
      catalogEntry({
        id: 'relative-plugin',
        displayName: 'Relative',
        source: './plugins/relative.zip',
      }),
      catalogEntry({
        id: 'kimi-browser-extension',
        displayName: 'Kimi Browser Extension',
        source: 'https://cdn.example.test/kimi-browser-extension.zip',
        distribution: { category: 'official', weight: 1 },
      }),
      catalogEntry({
        id: 'kimi-cu',
        displayName: 'Kimi Computer Use',
        source: 'https://cdn.example.test/kimi-cu.zip',
        distribution: { category: 'official', weight: 1 },
      }),
      catalogEntry({
        id: 'kimi-cu-win',
        displayName: 'Kimi Computer Use for Windows',
        source: 'https://cdn.example.test/kimi-cu-win.zip',
        distribution: { category: 'official', weight: 1 },
      }),
      catalogEntry({
        id: 'meta-plugin',
        displayName: 'Metadata',
        description: 'Full description',
        cliDescription: 'CLI description',
        locale: {
          defaultLocale: 'en-us',
          'zh-cn': { shortDescription: '短介绍', longDescription: '完整介绍' },
        },
        distribution: { category: 'third_party', weight: 1, userLevel: 'pro' },
      }),
      catalogEntry({ id: 'cloud-only', platforms: ['cloud'] }),
      catalogEntry({ id: 'cloud-and-local', platforms: ['cloud', 'macos', 'windows', 'linux'] }),
      catalogEntry({
        id: 'cloud-and-unsupported',
        platforms: ['cloud', process.platform === 'darwin' ? 'windows' : 'macos'],
      }),
      catalogEntry({
        id: 'unsupported-platform',
        platforms: [process.platform === 'darwin' ? 'windows' : 'macos'],
      }),
    ],
  };
}

describe('server-v2 /api/v1 plugins', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let custom = false;
  let catalog = createCatalog();
  let artifact: { source: string; buffer: Buffer; requireAuth: boolean } | undefined;
  let artifactAuthorizations: Array<string | undefined> = [];
  const createdDirs: string[] = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-plugins-'));
    await bootDefault();
  });

  async function bootDefault(): Promise<void> {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
      pluginMarketplaceUrl: CATALOG_URL,
    });
    base = `http://127.0.0.1:${server.port}`;
    custom = false;
  }

  beforeEach(async () => {
    catalog = createCatalog();
    artifact = undefined;
    artifactAuthorizations = [];
    await rm(join(home!, 'plugins', 'cache', 'archives'), { recursive: true, force: true });
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === CATALOG_URL || url === DEFAULT_CATALOG_URL || url === GLOBAL_CATALOG_URL) {
          return new Response(JSON.stringify(catalog), { status: 200 });
        }
        if (artifact !== undefined && url === artifact.source) {
          const authorization = new Headers(init?.headers).get('Authorization') ?? undefined;
          artifactAuthorizations.push(authorization);
          if (artifact.requireAuth && authorization !== 'Bearer managed-token') {
            return new Response(null, { status: 401 });
          }
          return new Response(artifact.buffer, { status: 200 });
        }
        return realFetch(url as never, init);
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (custom) {
      await server?.close();
      server = undefined;
      await bootDefault();
    }
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
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

  async function makePluginDir(id: string, version: string, withCapabilities = false): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `kimi-test-plugin-${id}-`));
    createdDirs.push(dir);
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({
        name: id,
        version,
        description: 'test plugin',
        interface: withCapabilities
          ? {
              defaultLocale: 'zh-CN',
              locales: './locales/',
              mcpOverrides: {
                demo: {
                  displayName: 'Demo MCP',
                  description: 'Demo MCP description',
                  iconUrl: 'https://example.com/demo-mcp.png',
                },
              },
              skillOverrides: {
                'demo-skill': {
                  displayName: 'Demo Skill',
                  description: 'Demo skill override',
                },
              },
            }
          : undefined,
        skills: withCapabilities ? ['./skills'] : undefined,
        mcpServers: withCapabilities
          ? { demo: { transport: 'stdio', command: 'node', args: ['server.js'] } }
          : undefined,
      }),
    );
    if (withCapabilities) {
      await mkdir(join(dir, 'locales'), { recursive: true });
      await writeFile(
        join(dir, 'locales', 'en-US.json'),
        JSON.stringify({
          mcpOverrides: {
            demo: {
              displayName: 'English MCP',
              description: 'English MCP description',
            },
          },
          skillOverrides: {
            'demo-skill': {
              displayName: 'English Skill',
              description: 'English skill description',
            },
          },
        }),
        'utf8',
      );
      await mkdir(join(dir, 'skills', 'demo-skill'), { recursive: true });
      await writeFile(
        join(dir, 'skills', 'demo-skill', 'SKILL.md'),
        '---\nname: demo-skill\ndescription: Demo skill\n---\n\nBody',
        'utf8',
      );
    }
    return dir;
  }

  async function makeZip(
    id: string,
    version: string,
    description = 'test plugin',
    withCapabilities = false,
  ): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), `kimi-test-plugin-zip-${id}-`));
    createdDirs.push(dir);
    const source = join(dir, 'source');
    await mkdir(source);
    await writeFile(
      join(source, 'kimi.plugin.json'),
      JSON.stringify({
        name: id,
        version,
        description,
        interface: withCapabilities
          ? {
              defaultLocale: 'zh-CN',
              locales: './locales/',
              mcpOverrides: {
                demo: {
                  displayName: 'Demo MCP',
                  description: 'Demo MCP description',
                  iconUrl: 'https://example.com/demo-mcp.png',
                },
              },
              skillOverrides: {
                'demo-skill': {
                  displayName: 'Demo Skill',
                  description: 'Demo skill override',
                },
              },
            }
          : undefined,
        skills: withCapabilities ? ['./skills'] : undefined,
        mcpServers: withCapabilities
          ? { demo: { transport: 'stdio', command: 'node', args: ['server.js'] } }
          : undefined,
      }),
    );
    if (withCapabilities) {
      await mkdir(join(source, 'locales'), { recursive: true });
      await writeFile(
        join(source, 'locales', 'en-US.json'),
        JSON.stringify({
          mcpOverrides: {
            demo: {
              displayName: 'English MCP',
              description: 'English MCP description',
            },
          },
          skillOverrides: {
            'demo-skill': {
              displayName: 'English Skill',
              description: 'English skill description',
            },
          },
        }),
        'utf8',
      );
      await mkdir(join(source, 'skills', 'demo-skill'), { recursive: true });
      await writeFile(
        join(source, 'skills', 'demo-skill', 'SKILL.md'),
        '---\nname: demo-skill\ndescription: Demo skill\n---\n\nBody',
        'utf8',
      );
    }
    const zipPath = join(dir, 'plugin.zip');
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: source });
    return readFile(zipPath);
  }

  async function useDemoArtifact(
    id = 'demo-plugin',
    version = '2.0.0',
    withCapabilities = false,
  ): Promise<Buffer> {
    const buffer = await makeZip(id, version, 'test plugin', withCapabilities);
    const entry = catalog.plugins[0]!;
    entry['version'] = version;
    entry['sha256sum'] = createHash('sha256').update(buffer).digest('hex');
    artifact = { source: entry['source'] as string, buffer, requireAuth: false };
    return buffer;
  }

  it('installs, lists, disables, enables, and removes a custom plugin', async () => {
    const empty = await call<{ plugins: unknown[] }>('GET', '/api/v1/plugins');
    expect(empty.body.data.plugins).toEqual([]);

    const source = await makePluginDir('demo-plugin', '1.0.0');
    const installed = await call<{
      id: string;
      version: string;
      enabled: boolean;
      origin: string;
      catalogId?: string;
      installedAt: string;
    }>('POST', '/api/v1/plugins', { source });
    expect(installed.body.code).toBe(0);
    expect(installed.body.data).toMatchObject({
      id: 'demo-plugin',
      version: '1.0.0',
      enabled: true,
      origin: 'custom',
      installedAt: expect.any(String),
    });
    expect(installed.body.data.catalogId).toBeUndefined();

    const list = await call<{ plugins: { id: string; enabled: boolean }[] }>(
      'GET',
      '/api/v1/plugins',
    );
    expect(list.body.data.plugins.map((p) => [p.id, p.enabled])).toEqual([['demo-plugin', true]]);

    expect((await call('POST', '/api/v1/plugins/demo-plugin:disable')).body.code).toBe(0);
    const afterDisable = await call<{ plugins: { enabled: boolean }[] }>('GET', '/api/v1/plugins');
    expect(afterDisable.body.data.plugins[0]?.enabled).toBe(false);
    expect((await call('POST', '/api/v1/plugins/demo-plugin:enable')).body.code).toBe(0);
    expect((await call('POST', '/api/v1/plugins/demo-plugin:remove')).body.code).toBe(0);
    expect((await call<{ plugins: unknown[] }>('GET', '/api/v1/plugins')).body.data.plugins).toEqual([]);
  });

  it('returns installed and marketplace capability details without installing', async () => {
    type CapabilityDetails = {
      skills: Array<{ name: string; displayName?: string; description?: string }>;
      mcpServers: Array<{
        name: string;
        displayName?: string;
        description?: string;
        iconUrl?: string;
        transport: string;
      }>;
    };
    const source = await makePluginDir('demo-plugin', '1.0.0', true);
    await call('POST', '/api/v1/plugins', { source });
    const info = await call<CapabilityDetails>('GET', '/api/v1/plugins/demo-plugin');
    expect(info.body.code).toBe(0);
    expect(info.body.data.skills).toEqual([
      { name: 'demo-skill', displayName: 'Demo Skill', description: 'Demo skill override' },
    ]);
    expect(info.body.data.mcpServers).toHaveLength(1);
    expect(info.body.data.mcpServers[0]).toMatchObject({
      name: 'demo',
      displayName: 'Demo MCP',
      description: 'Demo MCP description',
      iconUrl: 'https://example.com/demo-mcp.png',
      transport: 'stdio',
    });
    const localizedInfo = await call<CapabilityDetails>(
      'GET',
      '/api/v1/plugins/demo-plugin?locale=en-US',
    );
    expect(localizedInfo.body.data.skills).toEqual([
      { name: 'demo-skill', displayName: 'English Skill', description: 'English skill description' },
    ]);
    expect(localizedInfo.body.data.mcpServers[0]).toMatchObject({
      name: 'demo',
      displayName: 'English MCP',
      description: 'English MCP description',
      iconUrl: 'https://example.com/demo-mcp.png',
      transport: 'stdio',
    });
    await call('POST', '/api/v1/plugins/demo-plugin:remove');

    await useDemoArtifact('demo-plugin', '2.0.0', true);
    const preview = await call<CapabilityDetails>('POST', '/api/v1/plugins/preview', {
      marketplaceId: 'demo-plugin',
      expectedVersion: '2.0.0',
      locale: 'en-US',
    });
    expect(preview.body.code).toBe(0);
    expect(preview.body.data.skills).toEqual([
      { name: 'demo-skill', displayName: 'English Skill', description: 'English skill description' },
    ]);
    expect(preview.body.data.mcpServers).toHaveLength(1);
    expect(preview.body.data.mcpServers[0]).toMatchObject({
      name: 'demo',
      displayName: 'English MCP',
      description: 'English MCP description',
      iconUrl: 'https://example.com/demo-mcp.png',
      transport: 'stdio',
    });
    const installed = await call<{ plugins: unknown[] }>('GET', '/api/v1/plugins');
    expect(installed.body.data.plugins).toEqual([]);
  });

  it('rejects invalid actions and ambiguous install input', async () => {
    expect((await call('POST', '/api/v1/plugins/demo-plugin')).body.code).toBe(40001);
    expect((await call('POST', '/api/v1/plugins/demo-plugin:explode')).body.code).toBe(40001);
    expect((await call('POST', '/api/v1/plugins/nope:remove')).body.code).toBe(40419);
    expect((await call('POST', '/api/v1/plugins', { source: '' })).body.code).toBe(40001);
    expect(
      (
        await call('POST', '/api/v1/plugins', {
          source: '/tmp/demo',
          marketplaceId: 'demo-plugin',
          expectedVersion: '2.0.0',
        })
      ).body.code,
    ).toBe(40001);
    expect(
      (await call('POST', '/api/v1/plugins', { marketplaceId: 'demo-plugin' })).body.code,
    ).toBe(40001);
  });

  it('fans out event.plugin.changed over WS on install and remove', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/ws`, [
      `kimi-code.bearer.${bearerToken(server!)}`,
    ]);
    const types: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('message', () => resolve());
        ws.once('error', reject);
      });
      ws.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString('utf8')) as { type?: string };
        if (frame.type !== undefined) types.push(frame.type);
      });
      const source = await makePluginDir('demo-plugin', '1.0.0');
      await call('POST', '/api/v1/plugins', { source });
      await vi.waitFor(() => expect(types).toContain('event.plugin.changed'));
      await call('POST', '/api/v1/plugins/demo-plugin:remove');
      await vi.waitFor(() => {
        expect(types.filter((type) => type === 'event.plugin.changed').length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      ws.close();
    }
  });

  it('maps client-fixable install input errors to 4xx, never 50001', async () => {
    expect((await call('POST', '/api/v1/plugins', { source: 'relative/dir' })).body.code).toBe(40001);
    expect(
      (await call('POST', '/api/v1/plugins', { source: join(home!, 'no-such-plugin-dir') })).body.code,
    ).toBe(40409);
    const noManifest = await mkdtemp(join(tmpdir(), 'kimi-no-manifest-'));
    createdDirs.push(noManifest);
    expect((await call('POST', '/api/v1/plugins', { source: noManifest })).body.code).toBe(40001);
  });

  it('serves new-protocol metadata with live install state and platform filtering', async () => {
    const before = await call<{
      entries: Array<{
        id: string;
        classification: string;
        source: string;
        platforms?: string[];
        distribution?: { weight?: number; userLevel?: string };
        locale?: Record<string, unknown>;
        billing?: string;
        installed?: { version?: string; enabled: boolean };
        updateAvailable?: boolean;
        capabilityId?: string;
      }>;
    }>('GET', '/api/v1/plugins/marketplace');
    expect(before.body.code).toBe(0);
    const ids = before.body.data.entries.map((entry) => entry.id);
    expect(ids).toEqual([
      'demo-plugin',
      'third-party-plugin',
      'relative-plugin',
      'kimi-browser-extension',
      'kimi-cu',
      'kimi-cu-win',
      'meta-plugin',
      'cloud-only',
      'cloud-and-local',
    ]);
    expect(before.body.data.entries[0]).toMatchObject({
      classification: 'official',
      distribution: { weight: 100 },
      platforms: ['darwin', 'win32', 'linux'],
    });
    expect(before.body.data.entries[1]?.distribution?.weight).toBe(1);
    expect(before.body.data.entries.find((entry) => entry.id === 'relative-plugin')?.source).toBe(
      'http://marketplace.test/plugins/relative.zip',
    );
    expect(before.body.data.entries.find((entry) => entry.id === 'meta-plugin')).toMatchObject({
      defaultLocale: 'en-us',
      locale: { defaultLocale: 'en-us' },
      billing: 'free',
      distribution: { userLevel: 'pro' },
    });
    expect(before.body.data.entries.find((entry) => entry.id === 'kimi-browser-extension')?.capabilityId).toBeUndefined();

    const source = await makePluginDir('demo-plugin', '1.0.0');
    await call('POST', '/api/v1/plugins', { source });
    const after = await call<{
      entries: Array<{
        id: string;
        installed?: { version?: string; enabled: boolean };
        updateAvailable?: boolean;
      }>;
    }>('GET', '/api/v1/plugins/marketplace');
    expect(after.body.data.entries.find((entry) => entry.id === 'demo-plugin')).toMatchObject({
      installed: { version: '1.0.0', enabled: true },
      updateAvailable: true,
    });
    await call('POST', '/api/v1/plugins/demo-plugin:remove');
  });

  it('rejects invalid new-protocol catalogs', async () => {
    catalog = { plugins: [{ id: 'bad', displayName: 'Bad', source: '   ' }] };
    const missing = await call('GET', '/api/v1/plugins/marketplace');
    expect(missing.body.code).toBe(50001);
    expect(missing.body.msg).toContain('unavailable');

    catalog = {
      plugins: [catalogEntry({ distribution: { category: 'curated' } })],
    };
    const category = await call('GET', '/api/v1/plugins/marketplace');
    expect(category.body.code).toBe(50001);
    expect(category.body.msg).toContain('distribution.category');
  });

  it('treats the explicitly marked dev catalog as the default capability catalog', async () => {
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
    custom = true;

    const { body } = await call<{ entries: Array<{ id: string; capabilityId?: string }> }>(
      'GET',
      '/api/v1/plugins/marketplace',
    );
    expect(body.code).toBe(0);
    expect(
      body.data.entries.find((entry) => entry.id === 'kimi-browser-extension')?.capabilityId,
    ).toBe('kimi-webbridge');
    const expectedCuId =
      process.platform === 'darwin'
        ? 'kimi-cu'
        : process.platform === 'win32' && process.arch === 'x64'
          ? 'kimi-cu-win'
          : undefined;
    const cuIds = body.data.entries
      .map((entry) => entry.id)
      .filter((id) => id === 'kimi-cu' || id === 'kimi-cu-win');
    expect(cuIds).toEqual(expectedCuId === undefined ? [] : [expectedCuId]);
    if (expectedCuId === undefined) return;
    expect(
      body.data.entries.find((entry) => entry.id === expectedCuId)?.capabilityId,
    ).toBe('kimi-cu');

    const cuSource = await makePluginDir(expectedCuId, '0.5.4');
    await call('POST', '/api/v1/plugins', { source: cuSource });
    const after = await call<{
      entries: Array<{ id: string; installed?: { version?: string } }>;
    }>('GET', '/api/v1/plugins/marketplace');
    expect(
      after.body.data.entries.find((entry) => entry.id === expectedCuId)?.installed?.version,
    ).toBe('0.5.4');
    await call('POST', `/api/v1/plugins/${expectedCuId}:remove`);
  });

  it('maps the canonical WebBridge entry and projects legacy installed state', async () => {
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
    custom = true;
    catalog.plugins.push(
      catalogEntry({
        id: 'kimi-webbridge',
        source: 'https://cdn.example.test/legacy-webbridge.zip',
        distribution: { category: 'official', weight: 1 },
      }),
    );
    const legacySource = await makePluginDir('kimi-webbridge', '1.0.0');
    await call('POST', '/api/v1/plugins', { source: legacySource });

    const { body } = await call<{
      entries: Array<{
        id: string;
        capabilityId?: string;
        installed?: { version?: string; enabled: boolean };
        updateAvailable?: boolean;
      }>;
    }>('GET', '/api/v1/plugins/marketplace');

    expect(body.code).toBe(0);
    expect(body.data.entries.map((entry) => entry.id)).not.toContain('kimi-webbridge');
    expect(body.data.entries.find((entry) => entry.id === 'kimi-browser-extension')).toMatchObject({
      capabilityId: 'kimi-webbridge',
      installed: { version: '1.0.0', enabled: true },
      updateAvailable: true,
    });

    catalog.plugins = catalog.plugins.filter((entry) => entry['id'] !== 'kimi-browser-extension');
    const legacyOnly = await call<{ entries: Array<{ id: string }> }>(
      'GET',
      '/api/v1/plugins/marketplace',
    );
    expect(legacyOnly.body.code).toBe(0);
    expect(legacyOnly.body.data.entries.map((entry) => entry.id)).not.toContain('kimi-webbridge');
    const rejected = await call('POST', '/api/v1/plugins', {
      marketplaceId: 'kimi-webbridge',
      expectedVersion: '1.0.0',
    });
    expect(rejected.body.code).toBe(40001);
    expect(rejected.body.msg).toContain('install "kimi-browser-extension" instead');

    await server?.close();
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_FROM_DEV_SERVER', undefined);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    const customLegacyOnly = await call<{ entries: Array<{ id: string }> }>(
      'GET',
      '/api/v1/plugins/marketplace',
    );
    expect(customLegacyOnly.body.code).toBe(0);
    expect(customLegacyOnly.body.data.entries.map((entry) => entry.id)).not.toContain(
      'kimi-webbridge',
    );
    await call('POST', '/api/v1/plugins/kimi-webbridge:remove');
  });

  it('maps an unreachable custom marketplace to a catalog error', async () => {
    const currentFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (String(input) === CATALOG_URL) throw new Error('network down');
        return currentFetch(input as never, init);
      }),
    );
    const { body } = await call('GET', '/api/v1/plugins/marketplace');
    expect(body.code).toBe(50001);
    expect(body.msg).toContain('unavailable');
  });

  it('reads local new-protocol catalogs from plain paths and file URLs', async () => {
    await server?.close();
    const catalogDir = await mkdtemp(join(tmpdir(), 'kimi-local-catalog-'));
    createdDirs.push(catalogDir);
    const fileUrlPluginPath = join(catalogDir, 'plugins', 'file.zip');
    const localCatalog = {
      plugins: [
        catalogEntry({ id: 'local-plugin', source: './zips/local.zip' }),
        catalogEntry({ id: 'file-url-plugin', source: pathToFileURL(fileUrlPluginPath).href }),
      ],
    };
    await writeFile(join(catalogDir, 'marketplace.json'), JSON.stringify(localCatalog));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
      pluginMarketplaceUrl: pathToFileURL(join(catalogDir, 'marketplace.json')).href,
    });
    base = `http://127.0.0.1:${server.port}`;
    custom = true;

    const { body } = await call<{ entries: Array<{ id: string; source: string }> }>(
      'GET',
      '/api/v1/plugins/marketplace',
    );
    expect(body.code).toBe(0);
    expect(body.data.entries).toEqual([
      expect.objectContaining({
        id: 'local-plugin',
        source: join(catalogDir, 'zips', 'local.zip'),
      }),
      expect.objectContaining({ id: 'file-url-plugin', source: fileUrlPluginPath }),
    ]);
  });

  it('expands tilde paths in local catalogs and entry sources', async () => {
    await server?.close();
    const fakeHome = await mkdtemp(join(tmpdir(), 'kimi-tilde-home-'));
    createdDirs.push(fakeHome);
    await writeFile(
      join(fakeHome, 'marketplace.json'),
      JSON.stringify({
        plugins: [
          catalogEntry({ id: 'tilde-plugin', source: 'https://example.test/t.zip' }),
          catalogEntry({ id: 'tilde-entry-plugin', source: '~/plugins/t.zip' }),
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
    custom = true;

    const { body } = await call<{ entries: Array<{ id: string; source: string }> }>(
      'GET',
      '/api/v1/plugins/marketplace',
    );
    expect(body.code).toBe(0);
    expect(body.data.entries.map((entry) => entry.id)).toEqual(['tilde-plugin', 'tilde-entry-plugin']);
    expect(body.data.entries[1]?.source).toBe(join(fakeHome, 'plugins', 't.zip'));
  });

  it('installs a marketplace snapshot and converts origins across reinstalls', async () => {
    await useDemoArtifact();
    const installed = await call<{
      id: string;
      origin: string;
      catalogId?: string;
      installedAt: string;
      originalSource?: string;
    }>('POST', '/api/v1/plugins', {
      marketplaceId: 'demo-plugin',
      expectedVersion: '2.0.0',
    });
    expect(installed.body.code).toBe(0);
    expect(installed.body.data).toMatchObject({
      id: 'demo-plugin',
      origin: 'marketplace',
      catalogId: 'demo-plugin',
      installedAt: expect.any(String),
      originalSource: 'https://cdn.example.test/demo.zip',
    });
    expect(artifactAuthorizations).toEqual([undefined]);

    const customSource = await makePluginDir('demo-plugin', '3.0.0');
    const customInstall = await call<{ origin: string; catalogId?: string; installedAt: string }>(
      'POST',
      '/api/v1/plugins',
      { source: customSource },
    );
    expect(customInstall.body.data).toMatchObject({
      origin: 'custom',
      installedAt: installed.body.data.installedAt,
    });
    expect(customInstall.body.data.catalogId).toBeUndefined();

    const marketplaceAgain = await call<{ origin: string; installedAt: string }>(
      'POST',
      '/api/v1/plugins',
      { marketplaceId: 'demo-plugin', expectedVersion: '2.0.0' },
    );
    expect(marketplaceAgain.body.data).toMatchObject({
      origin: 'marketplace',
      installedAt: installed.body.data.installedAt,
    });
    await call('POST', '/api/v1/plugins/demo-plugin:remove');
  });

  it('uses a one-time marketplace source for both artifact download and SHA validation', async () => {
    const catalogBUrl = 'https://catalog-b.example.test/marketplace.json';
    const artifactA = 'https://cdn-a.example.test/demo.zip';
    const artifactB = 'https://cdn-b.example.test/demo.zip';
    const bufferA = await makeZip('demo-plugin', '2.0.0', 'from catalog A');
    const bufferB = await makeZip('demo-plugin', '2.0.0', 'from catalog B');
    catalog = {
      plugins: [
        catalogEntry({
          source: artifactA,
          sha256sum: createHash('sha256').update(bufferA).digest('hex'),
        }),
      ],
    };
    const catalogB = {
      plugins: [
        catalogEntry({
          source: artifactB,
          sha256sum: createHash('sha256').update(bufferB).digest('hex'),
        }),
      ],
    };
    const downloads: string[] = [];
    const currentFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === catalogBUrl) {
          return new Response(JSON.stringify(catalogB), { status: 200 });
        }
        if (url === artifactA || url === artifactB) {
          downloads.push(url);
          return new Response(url === artifactA ? bufferA : bufferB, { status: 200 });
        }
        return currentFetch(input as never, init);
      }),
    );
    const plugins = server!.core.accessor.get(IPluginService);

    const installedB = await plugins.installPlugin({
      marketplaceId: 'demo-plugin',
      expectedVersion: '2.0.0',
      marketplaceSource: catalogBUrl,
    });

    expect(installedB.originalSource).toBe(artifactB);
    expect((await plugins.getPluginInfo({ id: 'demo-plugin' })).manifest?.description).toBe(
      'from catalog B',
    );
    const defaultView = await server!.core.accessor.get(IPluginMarketplaceService).listMarketplace();
    expect(defaultView.source).toBe(CATALOG_URL);
    expect(defaultView.plugins[0]?.source).toBe(artifactA);

    const installedA = await plugins.installPlugin({
      marketplaceId: 'demo-plugin',
      expectedVersion: '2.0.0',
    });
    expect(installedA.originalSource).toBe(artifactA);
    expect((await plugins.getPluginInfo({ id: 'demo-plugin' })).manifest?.description).toBe(
      'from catalog A',
    );
    expect(downloads).toEqual([artifactB, artifactA]);
    await plugins.removePlugin({ id: 'demo-plugin' });
  });

  it('returns catalogChanged before downloading when expectedVersion is stale', async () => {
    await useDemoArtifact();
    const result = await call('POST', '/api/v1/plugins', {
      marketplaceId: 'demo-plugin',
      expectedVersion: '1.9.0',
    });
    expect(result.body.code).toBe(40933);
    expect(result.body.msg).toContain('refresh the catalog');
    expect(artifactAuthorizations).toEqual([]);
  });

  it('rejects SHA and manifest ID mismatches without installing', async () => {
    await useDemoArtifact();
    catalog.plugins[0]!['sha256sum'] = '0'.repeat(64);
    const sha = await call('POST', '/api/v1/plugins', {
      marketplaceId: 'demo-plugin',
      expectedVersion: '2.0.0',
    });
    expect(sha.body.code).toBe(40001);
    expect(sha.body.msg).toContain('SHA-256 mismatch');

    await useDemoArtifact('actual-id');
    const manifest = await call('POST', '/api/v1/plugins', {
      marketplaceId: 'demo-plugin',
      expectedVersion: '2.0.0',
    });
    expect(manifest.body.code).toBe(40001);
    expect(manifest.body.msg).toContain('manifest ID mismatch');
    const list = await call<{ plugins: unknown[] }>('GET', '/api/v1/plugins');
    expect(list.body.data.plugins).toEqual([]);
  });

  it('derives the default catalog and retries protected artifacts with managed OAuth', async () => {
    await server?.close();
    catalog.plugins[0]!['source'] = 'http://marketplace.test/artifacts/demo.zip';
    await useDemoArtifact();
    artifact!.requireAuth = true;
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', undefined);
    vi.stubEnv('KIMI_CODE_BASE_URL', 'http://marketplace.test/coding/v1/');
    vi.spyOn(KimiOAuthToolkit.prototype, 'tokenProvider').mockReturnValue({
      getAccessToken: async () => 'managed-token',
    });
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    custom = true;

    const catalogResponse = await call('GET', '/api/v1/plugins/marketplace');
    expect(catalogResponse.body.code).toBe(0);
    const catalogInit = vi.mocked(globalThis.fetch).mock.calls.find(
      ([input]) =>
        (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) ===
        DEFAULT_CATALOG_URL,
    )?.[1];
    const catalogAuthorization = new Headers(catalogInit?.headers).get('Authorization');
    expect(catalogAuthorization).toBe('Bearer managed-token');
    expect(catalogAuthorization).not.toBe(`Bearer ${bearerToken(server!)}`);

    const installed = await call<{ origin: string }>('POST', '/api/v1/plugins', {
      marketplaceId: 'demo-plugin',
      expectedVersion: '2.0.0',
    });
    expect(installed.body.code).toBe(0);
    expect(installed.body.data.origin).toBe('marketplace');
    expect(artifactAuthorizations).toEqual([undefined, 'Bearer managed-token']);
    await call('POST', '/api/v1/plugins/demo-plugin:remove');
  });

  it('does not send managed OAuth to a third-party artifact host after a 401', async () => {
    await server?.close();
    await useDemoArtifact();
    artifact!.requireAuth = true;
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', undefined);
    vi.stubEnv('KIMI_CODE_BASE_URL', 'http://marketplace.test/coding/v1');
    vi.spyOn(KimiOAuthToolkit.prototype, 'tokenProvider').mockReturnValue({
      getAccessToken: async () => 'managed-token',
    });
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    custom = true;

    const installed = await call('POST', '/api/v1/plugins', {
      marketplaceId: 'demo-plugin',
      expectedVersion: '2.0.0',
    });

    expect(installed.body.code).toBe(40001);
    expect(installed.body.msg).toContain('HTTP 401');
    expect(artifactAuthorizations).toEqual([undefined]);
  });

  it('does not retry managed OAuth when a codegw artifact redirects to a third-party origin', async () => {
    await server?.close();
    catalog.plugins[0]!['source'] = 'http://marketplace.test/artifacts/demo.zip';
    await useDemoArtifact();
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', undefined);
    vi.stubEnv('KIMI_CODE_BASE_URL', 'http://marketplace.test/coding/v1');
    vi.spyOn(KimiOAuthToolkit.prototype, 'tokenProvider').mockReturnValue({
      getAccessToken: async () => 'managed-token',
    });
    const currentFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (String(input) === artifact!.source) {
          artifactAuthorizations.push(new Headers(init?.headers).get('Authorization') ?? undefined);
          const response = new Response(null, { status: 401 });
          Object.defineProperty(response, 'url', {
            value: 'https://cdn.example.test/redirected-demo.zip',
          });
          return response;
        }
        return currentFetch(input as never, init);
      }),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    custom = true;

    const installed = await call('POST', '/api/v1/plugins', {
      marketplaceId: 'demo-plugin',
      expectedVersion: '2.0.0',
    });

    expect(installed.body.code).toBe(40001);
    expect(installed.body.msg).toContain('HTTP 401');
    expect(artifactAuthorizations).toEqual([undefined]);
  });

  it('uses the global region profile and matching OAuth ref for a fresh global home', async () => {
    await server?.close();
    const emptyHome = await mkdtemp(join(tmpdir(), 'kimi-global-plugin-home-'));
    createdDirs.push(emptyHome);
    await writeFile(join(emptyHome, 'region'), 'global');
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', undefined);
    vi.stubEnv('KIMI_CODE_BASE_URL', undefined);
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', undefined);
    vi.stubEnv('KIMI_OAUTH_HOST', undefined);
    vi.stubEnv('KIMI_CODE_REGION_MARKER', 'on');
    const tokenProvider = vi.spyOn(KimiOAuthToolkit.prototype, 'tokenProvider').mockReturnValue({
      getAccessToken: async () => 'managed-token',
    });
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: emptyHome,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    custom = true;

    const result = await call<{ entries: unknown[] }>('GET', '/api/v1/plugins/marketplace');

    expect(result.body.code).toBe(0);
    expect(
      vi.mocked(globalThis.fetch).mock.calls.some(([input]) => fetchInputUrl(input) === GLOBAL_CATALOG_URL),
    ).toBe(true);
    expect(tokenProvider).toHaveBeenCalledWith(
      KIMI_CODE_PROVIDER_NAME,
      resolveKimiCodeOAuthRef({ baseUrl: KIMI_REGION_PROFILES.global.baseUrl }),
    );
  });

  it('prefers provider baseURL over region and explicit env baseURL over provider', async () => {
    await server?.close();
    const providerHome = await mkdtemp(join(tmpdir(), 'kimi-provider-plugin-home-'));
    createdDirs.push(providerHome);
    const providerBaseUrl = 'http://provider.example.test/coding/v1/';
    const providerCatalogUrl = 'http://provider.example.test/coding/v1/plugins/marketplace';
    const envBaseUrl = 'http://env.example.test/coding/v1/';
    const envCatalogUrl = 'http://env.example.test/coding/v1/plugins/marketplace';
    const providerOAuthHost = 'https://auth.provider.example.test';
    const providerOAuthRef = resolveKimiCodeOAuthRef({
      baseUrl: providerBaseUrl,
      oauthHost: providerOAuthHost,
    });
    await writeFile(join(providerHome, 'region'), 'global');
    await writeFile(
      join(providerHome, 'config.toml'),
      [
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        `base_url = "${providerBaseUrl}"`,
        '',
        '[providers."managed:kimi-code".oauth]',
        'storage = "file"',
        `key = "${providerOAuthRef.key}"`,
        `oauth_host = "${providerOAuthHost}"`,
        '',
      ].join('\n'),
    );
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', undefined);
    vi.stubEnv('KIMI_CODE_BASE_URL', undefined);
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', undefined);
    vi.stubEnv('KIMI_OAUTH_HOST', undefined);
    vi.stubEnv('KIMI_CODE_REGION_MARKER', 'on');
    const tokenProvider = vi.spyOn(KimiOAuthToolkit.prototype, 'tokenProvider').mockReturnValue({
      getAccessToken: async () => 'managed-token',
    });
    const currentFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === providerCatalogUrl || url === envCatalogUrl) {
          return new Response(JSON.stringify(catalog), { status: 200 });
        }
        return currentFetch(input as never, init);
      }),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: providerHome,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    custom = true;

    const providerResult = await call<{ entries: unknown[] }>('GET', '/api/v1/plugins/marketplace');

    expect(providerResult.body.code).toBe(0);
    expect(
      vi.mocked(globalThis.fetch).mock.calls.some(([input]) => fetchInputUrl(input) === providerCatalogUrl),
    ).toBe(true);
    expect(tokenProvider).toHaveBeenCalledWith(KIMI_CODE_PROVIDER_NAME, providerOAuthRef);

    await server.close();
    vi.stubEnv('KIMI_CODE_BASE_URL', envBaseUrl);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: providerHome,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const envResult = await call<{ entries: unknown[] }>('GET', '/api/v1/plugins/marketplace');

    expect(envResult.body.code).toBe(0);
    expect(
      vi.mocked(globalThis.fetch).mock.calls.some(([input]) => fetchInputUrl(input) === envCatalogUrl),
    ).toBe(true);
    expect(tokenProvider).toHaveBeenLastCalledWith(
      KIMI_CODE_PROVIDER_NAME,
      resolveKimiCodeOAuthRef({ baseUrl: envBaseUrl }),
    );
  });

  it('allows anonymous default catalog access with an empty home', async () => {
    await server?.close();
    const emptyHome = await mkdtemp(join(tmpdir(), 'kimi-empty-plugin-home-'));
    createdDirs.push(emptyHome);
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', undefined);
    vi.stubEnv('KIMI_CODE_BASE_URL', 'http://marketplace.test/coding/v1');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: emptyHome,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    custom = true;

    const result = await call<{ entries: unknown[] }>('GET', '/api/v1/plugins/marketplace');

    expect(result.body.code).toBe(0);
    expect(result.body.data.entries.length).toBeGreaterThan(0);
    const catalogInit = vi.mocked(globalThis.fetch).mock.calls.find(
      ([input]) =>
        (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) ===
        DEFAULT_CATALOG_URL,
    )?.[1];
    expect(new Headers(catalogInit?.headers).get('Authorization')).toBeNull();
  });

  it('does not hide rejected managed credentials as anonymous catalog access', async () => {
    await server?.close();
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', undefined);
    vi.stubEnv('KIMI_CODE_BASE_URL', 'http://marketplace.test/coding/v1');
    const failure = new OAuthUnauthorizedError(
      'Stored token for "kimi-code" was rejected; re-login required.',
    );
    vi.spyOn(KimiOAuthToolkit.prototype, 'tokenProvider').mockReturnValue({
      getAccessToken: async () => {
        throw failure;
      },
    });
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    custom = true;

    const result = await call('GET', '/api/v1/plugins/marketplace');

    expect(result.body.code).toBe(50001);
    expect(result.body.msg).toContain('re-login required');
    expect(
      vi.mocked(globalThis.fetch).mock.calls.filter(
        ([input]) =>
          (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) ===
          DEFAULT_CATALOG_URL,
      ),
    ).toEqual([]);
  });

  it('does not retry a real catalog HTTP 401 anonymously', async () => {
    await server?.close();
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', undefined);
    vi.stubEnv('KIMI_CODE_BASE_URL', 'http://marketplace.test/coding/v1');
    vi.spyOn(KimiOAuthToolkit.prototype, 'tokenProvider').mockReturnValue({
      getAccessToken: async () => 'managed-token',
    });
    const currentFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (String(input) === DEFAULT_CATALOG_URL) return new Response(null, { status: 401 });
        return currentFetch(input as never, init);
      }),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    custom = true;

    const result = await call('GET', '/api/v1/plugins/marketplace');

    expect(result.body.code).toBe(50001);
    expect(result.body.msg).toContain('HTTP 401');
    expect(
      vi.mocked(globalThis.fetch).mock.calls.filter(
        ([input]) =>
          (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) ===
          DEFAULT_CATALOG_URL,
      ),
    ).toHaveLength(1);
  });

  it('does not fall back to the source checkout when the default catalog fails', async () => {
    await server?.close();
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', undefined);
    vi.stubEnv('KIMI_CODE_BASE_URL', 'http://marketplace.test/coding/v1');
    vi.spyOn(KimiOAuthToolkit.prototype, 'tokenProvider').mockReturnValue({
      getAccessToken: async () => 'managed-token',
    });
    const currentFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (String(input) === DEFAULT_CATALOG_URL) throw new Error('offline');
        return currentFetch(input as never, init);
      }),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home!,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    custom = true;

    const result = await call('GET', '/api/v1/plugins/marketplace');
    expect(result.body.code).toBe(50001);
    expect(result.body.msg).toContain('unavailable');
    expect((await call('GET', '/api/v1/plugins')).body.code).toBe(0);
  });

  it('projects unknown origin and installedAt for legacy installed records', async () => {
    await server?.close();
    const root = await makePluginDir('legacy-plugin', '1.0.0');
    await mkdir(join(home!, 'plugins'), { recursive: true });
    await writeFile(
      join(home!, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'legacy-plugin',
            root,
            source: 'local-path',
            enabled: true,
            installedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    await bootDefault();
    custom = true;

    const result = await call<{
      plugins: Array<{ id: string; origin: string; installedAt: string }>;
    }>('GET', '/api/v1/plugins');
    expect(result.body.data.plugins).toEqual([
      expect.objectContaining({
        id: 'legacy-plugin',
        origin: 'unknown',
        installedAt: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    await call('POST', '/api/v1/plugins/legacy-plugin:remove');
  });
});
