import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { AsyncEmitter, Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService, type ConfigSectionChangedEvent } from '#/app/config/config';
import { MCP_SECTION, type McpSection } from '#/app/mcpConfig/configSection';
import {
  IMcpConfigStore,
  type McpConfigWriteEvent,
} from '#/app/mcpConfig/configStore';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { IPluginService } from '#/app/plugin/plugin';
import type { PluginReloadEvent } from '#/app/plugin/types';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import {
  IWorkspaceMcpConfigService,
  type McpServersChange,
} from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import { WorkspaceMcpConfigService } from '#/workspace/workspaceMcpConfig/workspaceMcpConfigService';
import * as mcpConfigLoader from '#/app/mcpConfig/configLoader';
import {
  IWorkspaceTrust,
  type WorkspaceTrustChange,
} from '#/workspace/workspaceTrust/workspaceTrust';
import type { WatchChange } from '#human/utils/watch';

import { stubLog } from '../../_base/log/stubs';
import { createMemoryMcpOAuthStore } from '../../mcpCore/stubs';

const watchFires = new Map<string, Emitter<WatchChange>>();

vi.mock('#human/utils/watch', () => {
  const watch = (path: string) => {
    let emitter = watchFires.get(path);
    if (emitter === undefined) {
      emitter = new Emitter<WatchChange>();
      watchFires.set(path, emitter);
    }
    return { ready: Promise.resolve(), onDidChange: emitter.event, dispose: () => {} };
  };
  return {
    watch,
    watchCandidates: (root: string) => watch(root),
  };
});

function stdioConfig(command: string): McpServerConfig {
  return { transport: 'stdio', command, args: [] };
}

describe('WorkspaceMcpConfigService', () => {
  let cwd: string;
  let homeDir: string;
  let disposables: DisposableStore;
  let pluginServers: Record<string, McpServerConfig>;
  let pluginReloads: AsyncEmitter<PluginReloadEvent>;
  let storeWrites: AsyncEmitter<McpConfigWriteEvent>;
  let trusted: boolean;
  let trustFlips: Emitter<WorkspaceTrustChange>;
  let sectionChanges: Emitter<ConfigSectionChangedEvent>;
  let dirsChanges: Emitter<void>;
  let primaryDirs: IWorkspaceDirs;
  let changes: McpServersChange[];
  let cancelAuthorization: Mock<(source: object | undefined, serverName: string, serverUrl: string | URL) => Promise<void>>;
  let invalidate: Mock<(source: object | undefined, serverName: string, serverUrl: string | URL) => Promise<void>>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-config-cwd-'));
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-config-home-'));
    disposables = new DisposableStore();
    watchFires.clear();
    pluginServers = {};
    pluginReloads = disposables.add(new AsyncEmitter<PluginReloadEvent>());
    storeWrites = disposables.add(new AsyncEmitter<McpConfigWriteEvent>());
    trusted = true;
    trustFlips = new Emitter<WorkspaceTrustChange>();
    sectionChanges = disposables.add(new Emitter<ConfigSectionChangedEvent>());
    dirsChanges = disposables.add(new Emitter<void>());
    changes = [];
    cancelAuthorization = vi.fn(async () => undefined);
    invalidate = vi.fn(async () => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    disposables.dispose();
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(homeDir, { recursive: true, force: true }),
    ]);
  });

  function createService(
    mcpSection?: McpSection,
    trustReady: () => Promise<void> = () => Promise.resolve(),
    log: ILogService = stubLog(),
    oauth?: McpOAuthService,
  ): IWorkspaceMcpConfigService {
    primaryDirs = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      primary: cwd,
      onDidChange: dirsChanges.event,
    } as unknown as IWorkspaceDirs;
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IBootstrapService, { homeDir });
        reg.definePartialInstance(IWorkspaceContext, { cwd });
        reg.defineInstance(IWorkspaceDirs, primaryDirs);
        reg.definePartialInstance(IPluginService, {
          enabledMcpServers: async () =>
            Object.fromEntries(
              Object.entries(pluginServers).filter(([, config]) => config.enabled !== false),
            ),
          mcpServerEntries: async () =>
            Object.entries(pluginServers).map(([name, config]) => ({
              name,
              config,
              pluginId: 'plugin',
              serverName: name,
            })),
          onDidReload: pluginReloads.event,
        });
        reg.defineInstance(ILogService, log);
        reg.definePartialInstance(IConfigService, {
          ready: Promise.resolve(),
          onDidSectionChange: sectionChanges.event,
          get: <T = unknown>(domain: string): T =>
            (domain === MCP_SECTION ? mcpSection : undefined) as T,
        });
        reg.defineInstance(IHostFileSystem, new HostFileSystem());
        reg.definePartialInstance(IWorkspaceTrust, {
          get ready() {
            return trustReady();
          },
          get: async () => {
            await trustReady();
            return trusted;
          },
          isTrusted: () => trusted,
          onDidChange: trustFlips.event as IWorkspaceTrust['onDidChange'],
        });
        reg.definePartialInstance(IMcpConfigStore, { onDidWrite: storeWrites.event });
        reg.definePartialInstance(IMcpOAuthService, oauth ?? {
          cancelAuthorizationFromConfiguration: cancelAuthorization,
          invalidate: (name, url) => invalidate(undefined, name, url),
          invalidateFromConfiguration: invalidate,
          setConfigurationSource: vi.fn(),
          removeConfigurationSource: vi.fn(),
        });
        reg.define(IWorkspaceMcpConfigService, WorkspaceMcpConfigService);
      },
    });
    const service = ix.get(IWorkspaceMcpConfigService);
    service.onDidChange(({ upsert, remove }) => changes.push({ upsert, remove }));
    return service;
  }

  async function writeProjectConfig(servers: Record<string, McpServerConfig>): Promise<string> {
    const dir = join(cwd, '.kimi-code');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'mcp.json');
    await writeFile(file, JSON.stringify({ mcpServers: servers }), 'utf8');
    return file;
  }

  it('merges file and plugin servers in the initial resolve (file wins name collisions)', async () => {
    await writeProjectConfig({
      shared: stdioConfig('file-version'),
      fileOnly: stdioConfig('file'),
    });
    pluginServers = { shared: stdioConfig('plugin-version'), pluginOnly: stdioConfig('plugin') };

    const service = createService();
    await service.ready;

    expect(service.servers()).toEqual({
      shared: stdioConfig('file-version'),
      fileOnly: stdioConfig('file'),
      pluginOnly: stdioConfig('plugin'),
    });
    expect(changes).toEqual([]);
  });

  it('skips the project-level config files while the workspace is untrusted', async () => {
    await writeProjectConfig({ fileOnly: stdioConfig('file') });
    pluginServers = { pluginOnly: stdioConfig('plugin') };
    trusted = false;

    const service = createService();
    await service.ready;

    expect(service.servers()).toEqual({ pluginOnly: stdioConfig('plugin') });
  });

  it('skips the project-level config files when trust initialization fails', async () => {
    await writeProjectConfig({ fileOnly: stdioConfig('file') });

    const service = createService(undefined, () => Promise.reject(new Error('trust storage unavailable')));
    await service.ready;

    expect(service.servers()).toEqual({});
  });

  it('retries full initialization after trust recovery', async () => {
    await writeProjectConfig({ fileOnly: stdioConfig('file') });
    pluginServers = { pluginOnly: stdioConfig('plugin') };
    trusted = false;
    let attempts = 0;
    const service = createService(undefined, () => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error('trust storage unavailable'))
        : Promise.resolve();
    });
    await service.ready;
    expect(service.servers()).toEqual({});

    trustFlips.fire({ trusted: false });

    await vi.waitFor(() => {
      expect(changes).toEqual([{ upsert: { pluginOnly: stdioConfig('plugin') }, remove: [] }]);
    });
    expect(service.servers()).toEqual({ pluginOnly: stdioConfig('plugin') });
  });

  it('picks up the project servers when the workspace becomes trusted', async () => {
    await writeProjectConfig({ fileOnly: stdioConfig('file') });
    trusted = false;
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({});

    trusted = true;
    trustFlips.fire({ trusted: true });

    await vi.waitFor(
      () => {
        expect(changes).toEqual([{ upsert: { fileOnly: stdioConfig('file') }, remove: [] }]);
      },
      { timeout: 10000, interval: 50 },
    );
    expect(service.servers()).toEqual({ fileOnly: stdioConfig('file') });
  }, 20000);

  it('drops the project servers when the workspace loses trust', async () => {
    await writeProjectConfig({ fileOnly: stdioConfig('file') });
    pluginServers = { pluginOnly: stdioConfig('plugin') };
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({
      fileOnly: stdioConfig('file'),
      pluginOnly: stdioConfig('plugin'),
    });

    trusted = false;
    trustFlips.fire({ trusted: false });

    await vi.waitFor(
      () => {
        expect(changes).toEqual([{ upsert: {}, remove: ['fileOnly'] }]);
      },
      { timeout: 10000, interval: 50 },
    );
    expect(service.servers()).toEqual({ pluginOnly: stdioConfig('plugin') });
  }, 20000);

  it('exposes live tunables and publishes only reconnect delay changes', async () => {
    const mcpSection = { startupTimeoutMs: 1234, toolTimeoutMs: 5678, defaultDeferred: true };
    const service = createService(mcpSection);
    await service.ready;

    expect(service.tunables()).toEqual({ startupTimeoutMs: 1234, toolTimeoutMs: 5678, defaultDeferred: true });
    const tunableEvents: unknown[] = [];
    service.onDidChangeTunables((event) => tunableEvents.push(event));
    sectionChanges.fire({
      domain: MCP_SECTION,
      source: 'reload',
      value: { ...mcpSection, startupTimeoutMs: 999 },
      previousValue: mcpSection,
    });
    expect(tunableEvents).toEqual([]);
    sectionChanges.fire({
      domain: MCP_SECTION,
      source: 'reload',
      value: { ...mcpSection, reconnectMaxDelayMs: 100 },
      previousValue: mcpSection,
    });
    expect(tunableEvents).toEqual([
      { ...mcpSection, reconnectInitialDelayMs: undefined, reconnectMaxDelayMs: 100 },
    ]);
  });

  it('publishes the diff when a watched config file changes', async () => {
    const file = await writeProjectConfig({ alpha: stdioConfig('alpha') });
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({ alpha: stdioConfig('alpha') });

    await writeProjectConfig({ beta: stdioConfig('beta') });
    watchFires.get(cwd)?.fire({ path: file, action: 'modified', kind: 'file' });

    await vi.waitFor(
      () => {
        expect(changes).toEqual([{ upsert: { beta: stdioConfig('beta') }, remove: ['alpha'] }]);
      },
      { timeout: 10000, interval: 50 },
    );
    expect(service.servers()).toEqual({ beta: stdioConfig('beta') });
  }, 20000);

  it('revives the same-named plugin entry when the winning file entry vanishes', async () => {
    await writeProjectConfig({ shared: stdioConfig('file-version') });
    pluginServers = { shared: stdioConfig('plugin-version') };
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({ shared: stdioConfig('file-version') });

    await writeProjectConfig({});
    await storeWrites.fireAsync({}, new AbortController().signal);
    pluginServers = {
      shared: stdioConfig('plugin-version'),
      pluginOnly: stdioConfig('plugin'),
    };
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    await vi.waitFor(
      () => {
        expect(changes).toEqual([
          { upsert: { shared: stdioConfig('plugin-version') }, remove: [] },
          { upsert: { pluginOnly: stdioConfig('plugin') }, remove: [] },
        ]);
      },
      { timeout: 10000, interval: 50 },
    );
    expect(service.servers()).toEqual({
      shared: stdioConfig('plugin-version'),
      pluginOnly: stdioConfig('plugin'),
    });
  }, 20000);

  it('publishes a plugin server that appears on plugin reload', async () => {
    const service = createService();
    await service.ready;

    pluginServers = { gamma: stdioConfig('gamma') };
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    await vi.waitFor(
      () => {
        expect(changes).toEqual([{ upsert: { gamma: stdioConfig('gamma') }, remove: [] }]);
      },
      { timeout: 10000, interval: 50 },
    );
    expect(service.servers()).toEqual({ gamma: stdioConfig('gamma') });
  }, 20000);

  it('settles the plugin reload event only after the workspace reconcile is published', async () => {
    const service = createService();
    await service.ready;

    pluginServers = { gamma: stdioConfig('gamma') };
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    expect(changes).toEqual([{ upsert: { gamma: stdioConfig('gamma') }, remove: [] }]);
    expect(service.servers()).toEqual({ gamma: stdioConfig('gamma') });
  });

  it('removes a plugin server that vanishes on plugin reload', async () => {
    pluginServers = { alpha: stdioConfig('alpha') };
    const service = createService();
    await service.ready;

    pluginServers = {};
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    await vi.waitFor(
      () => {
        expect(changes).toEqual([{ upsert: {}, remove: ['alpha'] }]);
      },
      { timeout: 10000, interval: 50 },
    );
  }, 20000);

  it('cancels the previous remote authorization when a plugin server is removed', async () => {
    const url = 'https://mcp.example.test/mcp';
    pluginServers = { alpha: { transport: 'http', url, auth: 'oauth' } };
    const service = createService();
    await service.ready;

    pluginServers = {};
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    expect(cancelAuthorization).toHaveBeenCalledOnce();
    expect(cancelAuthorization).toHaveBeenCalledWith(service, 'alpha', url);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(service, 'alpha', url);
  });

  it('revokes the previous OAuth identity when a remote server URL changes', async () => {
    const previousUrl = 'https://mcp.example.test/mcp-a';
    const nextUrl = 'https://mcp.example.test/mcp-b';
    pluginServers = { alpha: { transport: 'http', url: previousUrl, auth: 'oauth' } };
    const service = createService();
    await service.ready;

    pluginServers = { alpha: { transport: 'http', url: nextUrl, auth: 'oauth' } };
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    expect(cancelAuthorization).toHaveBeenCalledWith(service, 'alpha', previousUrl);
    expect(invalidate).toHaveBeenCalledWith(service, 'alpha', previousUrl);
    expect(invalidate).not.toHaveBeenCalledWith(service, 'alpha', nextUrl);
  });

  it('preserves OAuth credentials when trust temporarily unloads a project server', async () => {
    const url = 'https://mcp.example.test/mcp';
    await writeProjectConfig({ alpha: { transport: 'http', url, auth: 'oauth' } });
    const service = createService();
    await service.ready;

    trusted = false;
    trustFlips.fire({ trusted: false });

    await vi.waitFor(() => {
      expect(service.servers()).toEqual({});
    });
    expect(cancelAuthorization).toHaveBeenCalledWith(service, 'alpha', url);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('revokes OAuth credentials for project servers removed while untrusted after re-trust', async () => {
    const url = 'https://mcp.example.test/mcp';
    await writeProjectConfig({ alpha: { transport: 'http', url, auth: 'oauth' } });
    const service = createService();
    await service.ready;
    trusted = false;
    trustFlips.fire({ trusted: false });
    await vi.waitFor(() => expect(service.servers()).toEqual({}));
    expect(invalidate).not.toHaveBeenCalled();

    await writeProjectConfig({});
    await storeWrites.fireAsync({}, new AbortController().signal);
    trusted = true;
    trustFlips.fire({ trusted: true });

    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith(service, 'alpha', url);
    });
  });

  it('revokes the previous OAuth identity for URL changes made while untrusted after re-trust', async () => {
    const previousUrl = 'https://mcp.example.test/mcp-a';
    const nextUrl = 'https://mcp.example.test/mcp-b';
    await writeProjectConfig({ alpha: { transport: 'http', url: previousUrl, auth: 'oauth' } });
    const service = createService();
    await service.ready;
    trusted = false;
    trustFlips.fire({ trusted: false });
    await vi.waitFor(() => expect(service.servers()).toEqual({}));
    expect(invalidate).not.toHaveBeenCalled();

    await writeProjectConfig({ alpha: { transport: 'http', url: nextUrl, auth: 'oauth' } });
    await storeWrites.fireAsync({}, new AbortController().signal);
    trusted = true;
    trustFlips.fire({ trusted: true });

    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith(service, 'alpha', previousUrl);
    });
    expect(invalidate).not.toHaveBeenCalledWith(service, 'alpha', nextUrl);
  });

  it('keeps untrusted OAuth identities in the shared reference set until re-trust', async () => {
    const url = 'https://mcp.example.test/mcp';
    const config: McpServerConfig = { transport: 'http', url, auth: 'oauth' };
    const oauth = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    await oauth.getProvider('alpha', url).saveTokens({ access_token: 'a', token_type: 'Bearer' });
    const cwdA = cwd;
    try {
      await writeProjectConfig({ alpha: config });
      const serviceA = createService(undefined, undefined, undefined, oauth);
      await serviceA.ready;
      trusted = false;
      trustFlips.fire({ trusted: false });
      await vi.waitFor(() => {
        expect(serviceA.servers()).toEqual({});
      });

      trusted = true;
      cwd = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-config-cwd-b-'));
      await writeProjectConfig({ alpha: config });
      const serviceB = createService(undefined, undefined, undefined, oauth);
      await serviceB.ready;
      await writeProjectConfig({});
      watchFires.get(cwd)?.fire({
        path: join(cwd, '.kimi-code', 'mcp.json'),
        action: 'modified',
        kind: 'file',
      });
      await vi.waitFor(() => {
        expect(serviceB.servers()).toEqual({});
      });
      expect((await oauth.tokenState('alpha', url)).hasTokens).toBe(true);

      trustFlips.fire({ trusted: true });
      await vi.waitFor(() => {
        expect(serviceA.servers()).toHaveProperty('alpha');
      });
      expect((await oauth.tokenState('alpha', url)).hasTokens).toBe(true);
    } finally {
      cwd = cwdA;
      await oauth.dispose();
    }
  });

  it('cancels the previous remote authorization when a plugin server is disabled', async () => {
    const url = 'https://mcp.example.test/mcp';
    const config: McpServerConfig = { transport: 'http', url, auth: 'oauth' };
    pluginServers = { alpha: config };
    const service = createService();
    await service.ready;

    pluginServers = { alpha: { ...config, enabled: false } };
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    expect(cancelAuthorization).toHaveBeenCalledOnce();
    expect(cancelAuthorization).toHaveBeenCalledWith(service, 'alpha', url);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('revokes the retained OAuth identity when a disabled plugin is reenabled with a new URL', async () => {
    const previousUrl = 'https://mcp.example.test/mcp-a';
    const nextUrl = 'https://mcp.example.test/mcp-b';
    const previous = { transport: 'http', url: previousUrl, auth: 'oauth' } as const;
    const next = { transport: 'http', url: nextUrl, auth: 'oauth' } as const;
    pluginServers = { alpha: previous };
    const service = createService();
    await service.ready;

    pluginServers = { alpha: { ...previous, enabled: false } };
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );
    pluginServers = { alpha: { ...next, enabled: false } };
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );
    expect(invalidate).not.toHaveBeenCalled();

    pluginServers = { alpha: next };
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    expect(invalidate).toHaveBeenCalledWith(service, 'alpha', previousUrl);
    expect(invalidate).not.toHaveBeenCalledWith(service, 'alpha', nextUrl);
  });

  it('revokes the retained OAuth identity when a disabled plugin is removed after a URL change', async () => {
    const previousUrl = 'https://mcp.example.test/mcp-a';
    const nextUrl = 'https://mcp.example.test/mcp-b';
    pluginServers = { alpha: { transport: 'http', url: previousUrl, auth: 'oauth' } };
    const service = createService();
    await service.ready;

    pluginServers = {
      alpha: { transport: 'http', url: previousUrl, auth: 'oauth', enabled: false },
    };
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );
    pluginServers = {
      alpha: { transport: 'http', url: nextUrl, auth: 'oauth', enabled: false },
    };
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );
    expect(invalidate).not.toHaveBeenCalled();

    pluginServers = {};
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    expect(invalidate).toHaveBeenCalledWith(service, 'alpha', previousUrl);
    expect(invalidate).not.toHaveBeenCalledWith(service, 'alpha', nextUrl);
  });

  it('retains the disabled plugin OAuth identity while a same-named file server uses it', async () => {
    const url = 'https://mcp.example.test/mcp';
    const config: McpServerConfig = { transport: 'http', url, auth: 'oauth' };
    await writeProjectConfig({ alpha: config });
    pluginServers = { alpha: config };
    const service = createService();
    await service.ready;

    pluginServers = { alpha: { ...config, enabled: false } };
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );
    pluginServers = {};
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('warns and continues removing the plugin server when authorization cleanup fails', async () => {
    const error = new Error('close failed');
    const log = stubLog();
    const warn = vi.spyOn(log, 'warn');
    cancelAuthorization.mockRejectedValue(error);
    pluginServers = {
      alpha: { transport: 'http', url: 'https://mcp.example.test/mcp', auth: 'oauth' },
    };
    const service = createService(undefined, undefined, log);
    await service.ready;
    changes = [];

    pluginServers = {};
    await expect(
      pluginReloads.fireAsyncConcurrent(
        { added: [], removed: [], errors: [] },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('mcp oauth authorization cleanup failed', {
      name: 'alpha',
      error,
    });
    expect(changes).toEqual([{ upsert: {}, remove: ['alpha'] }]);
  });

  it('keeps the winning file server when the same-named plugin entry vanishes', async () => {
    await writeProjectConfig({ shared: stdioConfig('file-version') });
    pluginServers = { shared: stdioConfig('plugin-version') };
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({ shared: stdioConfig('file-version') });

    pluginServers = {};
    await pluginReloads.fireAsyncConcurrent(
      { added: [], removed: [], errors: [] },
      new AbortController().signal,
    );

    expect(changes).toEqual([]);
    expect(service.servers()).toEqual({ shared: stdioConfig('file-version') });
  });

  it('reloads immediately on a management-plane write, without the watch debounce', async () => {
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({});

    await writeFile(
      join(homeDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { added: stdioConfig('added') } }),
      'utf8',
    );
    await storeWrites.fireAsync({}, new AbortController().signal);

    await vi.waitFor(
      () => {
        expect(changes).toEqual([{ upsert: { added: stdioConfig('added') }, remove: [] }]);
      },
      { timeout: 10000, interval: 20 },
    );
    expect(service.servers()).toEqual({ added: stdioConfig('added') });
  }, 20000);

  it('reloads project servers and moves the watcher when the primary changes', async () => {
    const first = cwd;
    await writeProjectConfig({ first: stdioConfig('first') });
    const service = createService();
    await service.ready;
    expect(service.servers()).toEqual({ first: stdioConfig('first') });
    Object.defineProperty(primaryDirs, 'primary', { get: () => cwd });
    const next = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-config-next-'));
    try {
      cwd = next;
      await writeProjectConfig({ second: stdioConfig('second') });
      dirsChanges.fire();
      await vi.waitFor(() => {
        expect(service.servers()).toEqual({ second: stdioConfig('second') });
      });
      const watcher = [...watchFires.entries()].find(([root]) => root === next || next.startsWith(`${root}/`))?.[1];
      expect(watcher).toBeDefined();

      changes = [];
      await writeProjectConfig({ second: stdioConfig('updated') });
      watcher!.fire({ path: join(next, '.kimi-code', 'mcp.json'), action: 'modified', kind: 'file' });
      await vi.waitFor(() => {
        expect(service.servers()).toEqual({ second: stdioConfig('updated') });
      });
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(next, { recursive: true, force: true }),
      ]);
      cwd = first;
    }
  });

  it('serializes initial watcher setup with a primary change', async () => {
    const first = cwd;
    let releaseInitial!: () => void;
    let markInitialStarted!: () => void;
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const initialStarted = new Promise<void>((resolve) => {
      markInitialStarted = resolve;
    });
    const resolvePaths = mcpConfigLoader.resolveMcpJsonPaths;
    const resolver = vi.spyOn(mcpConfigLoader, 'resolveMcpJsonPaths').mockImplementation(
      async (input) => {
        if (input.cwd === first) {
          markInitialStarted();
          await initialGate;
        }
        return resolvePaths(input);
      },
    );
    const service = createService();
    const next = mkdtempSync(join(tmpdir(), 'kimi-workspace-mcp-config-next-'));
    try {
      await initialStarted;
      Object.defineProperty(primaryDirs, 'primary', { get: () => cwd });
      cwd = next;
      dirsChanges.fire();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(watchFires.has(next)).toBe(false);

      releaseInitial();
      await vi.waitFor(() => {
        expect(watchFires.has(next)).toBe(true);
      });
      expect([...watchFires.keys()].at(-1)).toBe(next);
      await service.ready;
    } finally {
      releaseInitial();
      resolver.mockRestore();
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(next, { recursive: true, force: true }),
      ]);
      cwd = first;
    }
  });
});
