/**
 * `plugin` domain (L3) — App-scope `PluginService` boundary scenarios.
 *
 * Covers load-failure degradation and recovery, serialized catalog changes,
 * coded management errors, and managed endpoint injection. Resolves the real
 * service by interface through a scoped host; bootstrap, provider, and skill
 * discovery are stubbed, while the installed-file store remains real except
 * for controlled read/write failures used for concurrency and rollback.
 *
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/app/plugin/pluginService.test.ts
 */

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IPluginService } from '#/app/plugin/plugin';
import { PluginService } from '#/app/plugin/pluginService';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import * as pluginStore from '#/app/plugin/store';
import type { InstalledFile } from '#/app/plugin/store';
import type { ReloadSummary } from '#/app/plugin/types';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubProviderService } from '../provider/stubs';

vi.mock('#/app/plugin/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/app/plugin/store')>();
  return {
    ...actual,
    readInstalled: vi.fn(actual.readInstalled),
    writeInstalled: vi.fn(actual.writeInstalled),
  };
});

const readInstalled = vi.mocked(pluginStore.readInstalled);
const writeInstalled = vi.mocked(pluginStore.writeInstalled);

function makeHost(
  homeDir: string,
  providers = stubProviderService(),
  env: NodeJS.ProcessEnv = {},
): ScopedTestHost {
  return createScopedTestHost([
    stubPair(IBootstrapService, stubBootstrap(homeDir, env)),
    stubPair(IProviderService, providers),
    stubPair(ISkillDiscovery, {
      _serviceBrand: undefined,
      discover: async () => ({ skills: [], skipped: [], scannedRoots: [] }),
    } satisfies ISkillDiscovery),
  ]);
}

async function writeInstalledFile(homeDir: string, contents: string): Promise<void> {
  await mkdir(path.join(homeDir, 'plugins'), { recursive: true });
  await writeFile(path.join(homeDir, 'plugins', 'installed.json'), contents, 'utf8');
}

async function writeValidInstalledFile(homeDir: string): Promise<void> {
  await writeInstalledFile(homeDir, JSON.stringify({ version: 1, plugins: [] }));
}

function installedFile(id: string, root: string, enabled = true): InstalledFile {
  return {
    version: 1,
    plugins: [
      {
        id,
        root,
        source: 'local-path',
        enabled,
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        originalSource: root,
      },
    ],
  };
}

function githubInstalledFile(id: string, root: string): InstalledFile {
  const local = installedFile(id, root).plugins[0]!;
  return {
    version: 1,
    plugins: [
      {
        ...local,
        source: 'github',
        originalSource: `https://github.com/example/${id}`,
        github: {
          owner: 'example',
          repo: id,
          ref: { kind: 'tag', value: 'v1.0.0' },
        },
      },
    ],
  };
}

async function persistedPluginIds(homeDir: string): Promise<readonly string[]> {
  const contents = await readFile(path.join(homeDir, 'plugins', 'installed.json'), 'utf8');
  return (JSON.parse(contents) as InstalledFile).plugins.map((plugin) => plugin.id);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function makePluginDir(
  name: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `plugin-${name}-`));
  await writeFile(
    path.join(root, 'kimi.plugin.json'),
    JSON.stringify({ name, ...manifest }),
    'utf8',
  );
  return realpath(root);
}

describe('PluginService (plugin boundary)', () => {
  const createdDirs: string[] = [];

  async function makeHome(): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    createdDirs.push(home);
    return home;
  }

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IPluginService,
      PluginService,
      InstantiationType.Delayed,
      'plugin',
    );
    readInstalled.mockClear();
    writeInstalled.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
  });

  it('degrades consumption-plane reads to empty when installed.json is corrupt', async () => {
    const home = await makeHome();
    await writeInstalledFile(home, '{ not json');
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.pluginSkillRoots()).resolves.toEqual([]);
      await expect(svc.enabledSessionStarts()).resolves.toEqual([]);
      await expect(svc.enabledHooks()).resolves.toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('resolves empty plugin MCP servers instead of failing when installed.json is corrupt', async () => {
    const home = await makeHome();
    await writeInstalledFile(home, '{ not json');
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.enabledMcpServers()).resolves.toEqual({});
    } finally {
      host.dispose();
    }
  });

  it('throws plugin.load_failed with a repair hint on management-plane calls when installed.json is corrupt', async () => {
    const home = await makeHome();
    await writeInstalledFile(home, '{ not json');
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const failure = await svc.listPlugins().catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'plugin.load_failed' });
      expect((failure as Error).message).toContain('installed.json');
      expect((failure as Error).message).toContain('/plugins reload');
    } finally {
      host.dispose();
    }
  });

  it('keeps the first load failure latched after the file is fixed', async () => {
    const home = await makeHome();
    await writeInstalledFile(home, '{ not json');
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.pluginSkillRoots()).resolves.toEqual([]);

      const pluginRoot = await makePluginDir('recovery-demo', {});
      createdDirs.push(pluginRoot);
      await writeInstalledFile(home, JSON.stringify(installedFile('recovery-demo', pluginRoot)));

      await expect(svc.listPlugins()).rejects.toMatchObject({ code: 'plugin.load_failed' });
      await expect(svc.pluginSkillRoots()).resolves.toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('recovers the management plane through an explicit reload after the file is fixed', async () => {
    const home = await makeHome();
    await writeInstalledFile(home, '{ not json');
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.listPlugins()).rejects.toMatchObject({ code: 'plugin.load_failed' });

      const pluginRoot = await makePluginDir('recovery-demo', {});
      createdDirs.push(pluginRoot);
      await writeInstalledFile(home, JSON.stringify(installedFile('recovery-demo', pluginRoot)));
      const reloads: ReloadSummary[] = [];
      svc.onDidReload((summary) => reloads.push(summary));

      await expect(svc.reloadPlugins()).resolves.toEqual({
        added: ['recovery-demo'],
        removed: [],
        errors: [],
      });
      await expect(svc.listPlugins()).resolves.toEqual([
        expect.objectContaining({ id: 'recovery-demo' }),
      ]);
      expect(reloads).toEqual([{ added: ['recovery-demo'], removed: [], errors: [] }]);
    } finally {
      host.dispose();
    }
  });

  it('keeps the last valid consumption snapshot after a reload failure', async () => {
    const home = await makeHome();
    const pluginRoot = await makePluginDir('stable-demo', { skills: './skills/' });
    createdDirs.push(pluginRoot);
    await mkdir(path.join(pluginRoot, 'skills'));
    await writeInstalledFile(home, JSON.stringify(installedFile('stable-demo', pluginRoot)));
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.pluginSkillRoots()).resolves.toEqual([
        expect.objectContaining({ plugin: expect.objectContaining({ id: 'stable-demo' }) }),
      ]);

      await writeInstalledFile(home, '{ not json');
      await expect(svc.reloadPlugins()).rejects.toMatchObject({ code: 'plugin.load_failed' });
      await expect(svc.listPlugins()).rejects.toMatchObject({ code: 'plugin.load_failed' });
      await expect(svc.pluginSkillRoots()).resolves.toEqual([
        expect.objectContaining({ plugin: expect.objectContaining({ id: 'stable-demo' }) }),
      ]);
    } finally {
      host.dispose();
    }
  });

  it('uses one initial plugin snapshot for concurrent readers', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const pluginRoot = await makePluginDir('snapshot-demo', { skills: './skills/' });
    createdDirs.push(pluginRoot);
    await mkdir(path.join(pluginRoot, 'skills'));
    readInstalled.mockImplementationOnce(async () => installedFile('snapshot-demo', pluginRoot));
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const [plugins, roots] = await Promise.all([
        svc.listPlugins(),
        svc.pluginSkillRoots(),
      ]);

      expect(plugins).toEqual([expect.objectContaining({ id: 'snapshot-demo' })]);
      expect(roots).toEqual([
        expect.objectContaining({
          plugin: expect.objectContaining({ id: 'snapshot-demo' }),
        }),
      ]);
    } finally {
      host.dispose();
    }
  });

  it('waits for a pending install before reading managed plugin files', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const downloadStarted = deferred<void>();
    const downloadResponse = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        downloadStarted.resolve(undefined);
        return downloadResponse.promise;
      }) as typeof fetch,
    );
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.listPlugins()).resolves.toEqual([]);

      const install = svc.installPlugin({ source: 'https://downloads.example.test/plugin.zip' });
      await downloadStarted.promise;

      const roots = svc.pluginSkillRoots();
      let rootsSettled = false;
      void roots.then(() => {
        rootsSettled = true;
      });
      await Promise.resolve();
      expect(rootsSettled).toBe(false);

      downloadResponse.resolve(new Response('not a zip archive', { status: 200 }));
      await expect(install).rejects.toThrow();
      await expect(roots).resolves.toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('restores the previous managed copy when reinstall persistence fails', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const previousSource = await makePluginDir('demo', { version: '1.0.0' });
    const nextSource = await makePluginDir('demo', { version: '2.0.0' });
    createdDirs.push(previousSource, nextSource);
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await svc.installPlugin({ source: previousSource });
      const previous = await svc.getPluginInfo({ id: 'demo' });

      writeInstalled.mockRejectedValueOnce(new Error('persist failed'));
      await expect(svc.installPlugin({ source: nextSource })).rejects.toThrow('persist failed');

      await expect(svc.getPluginInfo({ id: 'demo' })).resolves.toEqual(
        expect.objectContaining({ root: previous.root, version: '1.0.0' }),
      );
      await expect(readFile(path.join(previous.root, 'kimi.plugin.json'), 'utf8')).resolves.toContain(
        '"version":"1.0.0"',
      );
      await expect(readdir(path.join(home, 'plugins', 'managed'))).resolves.toEqual(['demo']);
    } finally {
      host.dispose();
    }
  });

  it('does not block consumption reads while an update check is pending', async () => {
    const home = await makeHome();
    const pluginRoot = await makePluginDir('github-demo', { skills: './skills/' });
    createdDirs.push(pluginRoot);
    await mkdir(path.join(pluginRoot, 'skills'));
    await writeInstalledFile(home, JSON.stringify(githubInstalledFile('github-demo', pluginRoot)));
    const lookupStarted = deferred<void>();
    const lookupResponse = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        lookupStarted.resolve(undefined);
        return lookupResponse.promise;
      }) as typeof fetch,
    );
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.listPlugins()).resolves.toEqual([
        expect.objectContaining({ id: 'github-demo' }),
      ]);

      const updates = svc.checkUpdates();
      await lookupStarted.promise;

      await expect(svc.pluginSkillRoots()).resolves.toEqual([
        expect.objectContaining({ plugin: expect.objectContaining({ id: 'github-demo' }) }),
      ]);

      lookupResponse.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://github.com/example/github-demo/releases/tag/v2.0.0',
          },
        }),
      );
      await expect(updates).resolves.toEqual([
        expect.objectContaining({ id: 'github-demo', updateAvailable: true }),
      ]);
    } finally {
      host.dispose();
    }
  });

  it('keeps an explicit reload result when the first load is still in flight', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const pluginRoot = await makePluginDir('old-demo', {});
    createdDirs.push(pluginRoot);
    const firstRead = deferred<InstalledFile>();
    const firstReadStarted = deferred<void>();
    readInstalled.mockImplementationOnce(async () => {
      firstReadStarted.resolve(undefined);
      return firstRead.promise;
    });
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const reloads: ReloadSummary[] = [];
      svc.onDidReload((summary) => reloads.push(summary));

      const firstList = svc.listPlugins();
      await firstReadStarted.promise;
      const reload = svc.reloadPlugins();
      firstRead.resolve(installedFile('old-demo', pluginRoot));

      await expect(firstList).resolves.toEqual([expect.objectContaining({ id: 'old-demo' })]);
      await expect(reload).resolves.toEqual({ added: [], removed: ['old-demo'], errors: [] });
      await expect(svc.listPlugins()).resolves.toEqual([]);
      await expect(persistedPluginIds(home)).resolves.toEqual([]);
      expect(reloads).toEqual([{ added: [], removed: ['old-demo'], errors: [] }]);
    } finally {
      host.dispose();
    }
  });

  it('keeps a queued removal when reload is already reading the installed file', async () => {
    const home = await makeHome();
    const pluginRoot = await makePluginDir('demo', {});
    createdDirs.push(pluginRoot);
    await writeInstalledFile(home, JSON.stringify(installedFile('demo', pluginRoot)));
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.listPlugins()).resolves.toEqual([
        expect.objectContaining({ id: 'demo', enabled: true }),
      ]);
      const reloadRead = deferred<InstalledFile>();
      const reloadReadStarted = deferred<void>();
      readInstalled.mockImplementationOnce(async () => {
        reloadReadStarted.resolve(undefined);
        return reloadRead.promise;
      });

      const reload = svc.reloadPlugins();
      await reloadReadStarted.promise;
      const remove = svc.removePlugin({ id: 'demo' });
      await Promise.resolve();
      reloadRead.resolve(installedFile('demo', pluginRoot));

      await expect(reload).resolves.toEqual({ added: [], removed: [], errors: [] });
      await expect(remove).resolves.toBeUndefined();
      await expect(svc.listPlugins()).resolves.toEqual([]);
      await expect(persistedPluginIds(home)).resolves.toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('throws plugin.not_found from getPluginInfo for an unknown plugin', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      await expect(svc.getPluginInfo({ id: 'nope' })).rejects.toMatchObject({
        code: 'plugin.not_found',
      });
    } finally {
      host.dispose();
    }
  });

  it('injects the managed Kimi endpoint env into stdio plugin MCP servers only', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const host = makeHost(
      home,
      stubProviderService({
        [KIMI_CODE_PROVIDER_NAME]: {
          baseUrl: 'https://api.example.test/',
          oauth: { storage: 'file', key: 'kimi', oauthHost: 'https://auth.example.test' },
        },
      }),
    );
    try {
      const svc = host.app.accessor.get(IPluginService);
      const pluginRoot = await makePluginDir('demo', {
        mcpServers: {
          finance: { command: 'finance-mcp', env: { CUSTOM: '1' } },
          docs: { url: 'https://example.test/mcp' },
        },
      });
      createdDirs.push(pluginRoot);
      await svc.installPlugin({ source: pluginRoot });

      const servers = await svc.enabledMcpServers();
      const managedRoot = path.join(home, 'plugins', 'managed', 'demo');
      expect(servers['plugin-demo:finance']).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            KIMI_CODE_BASE_URL: 'https://api.example.test/',
            KIMI_CODE_OAUTH_HOST: 'https://auth.example.test',
            CUSTOM: '1',
            KIMI_CODE_HOME: home,
            KIMI_PLUGIN_ROOT: await realpath(managedRoot),
          }),
        }),
      );
      expect(JSON.stringify(servers['plugin-demo:docs'])).not.toContain('KIMI_CODE_BASE_URL');
    } finally {
      host.dispose();
    }
  });

  it('waits for provider config before injecting persisted managed endpoints', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const providerConfigs: Record<string, ProviderConfig> = {};
    const readyAccessed = deferred<void>();
    const readyGate = deferred<void>();
    const providers = stubProviderService(providerConfigs, readyGate.promise);
    Object.defineProperty(providers, 'ready', {
      get: () => {
        readyAccessed.resolve(undefined);
        return readyGate.promise;
      },
    });
    const host = makeHost(home, providers);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const pluginRoot = await makePluginDir('ready-demo', {
        mcpServers: { finance: { command: 'finance-mcp' } },
      });
      createdDirs.push(pluginRoot);
      await svc.installPlugin({ source: pluginRoot });

      const servers = svc.enabledMcpServers();
      await readyAccessed.promise;
      providerConfigs[KIMI_CODE_PROVIDER_NAME] = {
        baseUrl: 'https://ready.example.test/',
        oauth: { storage: 'file', key: 'kimi', oauthHost: 'https://auth.ready.example.test' },
      };
      readyGate.resolve(undefined);

      await expect(servers).resolves.toMatchObject({
        'plugin-ready-demo:finance': {
          env: {
            KIMI_CODE_BASE_URL: 'https://ready.example.test/',
            KIMI_CODE_OAUTH_HOST: 'https://auth.ready.example.test',
          },
        },
      });
    } finally {
      host.dispose();
    }
  });

  it('prefers explicit KIMI_CODE_BASE_URL / KIMI_OAUTH_HOST env over the persisted provider', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const host = makeHost(
      home,
      stubProviderService({
        [KIMI_CODE_PROVIDER_NAME]: {
          baseUrl: 'https://api.example.test',
          oauth: { storage: 'file', key: 'kimi', oauthHost: 'https://auth.example.test' },
        },
      }),
      {
        KIMI_CODE_BASE_URL: 'https://env.example.test/',
        KIMI_OAUTH_HOST: 'https://legacy.example.test',
      },
    );
    try {
      const svc = host.app.accessor.get(IPluginService);
      const pluginRoot = await makePluginDir('demo', {
        mcpServers: { finance: { command: 'finance-mcp' } },
      });
      createdDirs.push(pluginRoot);
      await svc.installPlugin({ source: pluginRoot });

      const servers = await svc.enabledMcpServers();
      expect(servers['plugin-demo:finance']).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            KIMI_CODE_BASE_URL: 'https://env.example.test',
            KIMI_CODE_OAUTH_HOST: 'https://legacy.example.test',
          }),
        }),
      );
    } finally {
      host.dispose();
    }
  });

  it('does not inject managed env when neither env nor the kimi provider supplies it', async () => {
    const home = await makeHome();
    await writeValidInstalledFile(home);
    const host = makeHost(home);
    try {
      const svc = host.app.accessor.get(IPluginService);
      const pluginRoot = await makePluginDir('demo', {
        mcpServers: { finance: { command: 'finance-mcp', env: { CUSTOM: '1' } } },
      });
      createdDirs.push(pluginRoot);
      await svc.installPlugin({ source: pluginRoot });

      const servers = await svc.enabledMcpServers();
      const env = (servers['plugin-demo:finance'] as { env?: Record<string, string> }).env ?? {};
      expect(env['CUSTOM']).toBe('1');
      expect(env).not.toHaveProperty('KIMI_CODE_BASE_URL');
      expect(env).not.toHaveProperty('KIMI_CODE_OAUTH_HOST');
    } finally {
      host.dispose();
    }
  });
});
