import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  IAgentIdentity,
  type AgentIdentitySnapshot,
} from '#/app/agentIdentity/agentIdentity';
import { IConfigService } from '#/app/config/config';
import { IMcpConfigStore, McpConfigStore } from '#/app/mcpConfig/configStore';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import {
  IMcpManagementService,
  type GlobalMcpServerConfig,
  type McpServerLocator,
} from '#/app/mcpManagement/mcpManagement';
import { McpManagementService } from '#/app/mcpManagement/mcpManagementService';
import { IMcpRegistryService } from '#/app/mcpRegistry/mcpRegistry';
import { McpRegistryService } from '#/app/mcpRegistry/mcpRegistryService';
import { IPluginService } from '#/app/plugin/plugin';
import type { PluginMcpServerEntry } from '#/app/plugin/types';
import { ErrorCodes, Error2 } from '#/errors';
import { McpOAuthService, type McpOAuthEvent } from '#/mcpCore/oauth/service';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { stubLog } from '../../_base/log/stubs';
import {
  createMemoryMcpOAuthStore,
  startInProcessHttpMcpServer,
  stdioFixture,
} from '../../mcpCore/stubs';
import { stubAgentIdentity } from '../agentIdentity/stubs';

function stdioServer(name: string, command = 'npx'): GlobalMcpServerConfig {
  return { name, transport: 'stdio', command };
}

const CONFIG_SCOPE = '';
const CONFIG_KEY = 'mcp.json';

const textEncoder = new TextEncoder();

describe('McpManagementService', () => {
  let home: string;
  let disposables: DisposableStore;
  let tempDirs: string[];
  let httpServers: Array<{ close: () => Promise<void> }>;
  let storage: InMemoryStorageService;
  let store: IMcpConfigStore;
  let pluginEntries: PluginMcpServerEntry[];
  let pluginError: Error | undefined;
  let oauth: McpOAuthService;
  let configReady: Promise<void>;
  let identityReady: Promise<AgentIdentitySnapshot>;
  let identitySnapshot: AgentIdentitySnapshot;
  let trusted: boolean;
  let getOrCreate: Mock<IWorkspaceInstanceManager['getOrCreate']>;
  let findContaining: Mock<IWorkspaceInstanceManager['findContaining']>;
  let management: IMcpManagementService;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-home-'));
    vi.stubEnv('KIMI_CODE_HOME', home);
    disposables = new DisposableStore();
    tempDirs = [home];
    httpServers = [];
    storage = new InMemoryStorageService();
    pluginEntries = [];
    pluginError = undefined;
    oauth = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    configReady = Promise.resolve();
    identitySnapshot = stubAgentIdentity({ slug: 'test-agent' }).current();
    identityReady = Promise.resolve(identitySnapshot);
    trusted = true;
    getOrCreate = vi.fn<IWorkspaceInstanceManager['getOrCreate']>(async () =>
      ({ id: 'test-workspace' }) as unknown as WorkspaceInstance,
    );
    findContaining = vi.fn<IWorkspaceInstanceManager['findContaining']>(() => undefined);
    const hostProcess = new HostProcessService();
    const runtime = Object.assign(
      new FakeRuntime(
        { workspaceId: 'test-workspace', runtimeId: 'local', generation: 'test-generation' },
        { capabilities: ['process'] },
      ),
      { process: hostProcess },
    );
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, storage);
        reg.definePartialInstance(IBootstrapService, { homeDir: home });
        reg.define(IMcpConfigStore, McpConfigStore);
        reg.definePartialInstance(IPluginService, {
          mcpServerEntries: async () => {
            if (pluginError !== undefined) throw pluginError;
            return pluginEntries;
          },
        });
        reg.defineInstance(IHostFileSystem, new HostFileSystem());
        reg.defineInstance(IHostEnvironment, {
          _serviceBrand: undefined,
          osKind: 'Linux',
          osArch: 'x64',
          osVersion: 'test',
          shellName: 'bash',
          shellPath: '/bin/bash',
          pathClass: 'posix',
          homeDir: home,
          ready: Promise.resolve(),
        });
        reg.defineInstance(IHostProcessService, hostProcess);
        reg.definePartialInstance(IAtomicDocumentStore, {
          get: async <T>() => (trusted ? ({} as T) : undefined),
        });
        reg.define(IMcpRegistryService, McpRegistryService);
        reg.defineInstance(IMcpOAuthService, oauth);
        reg.definePartialInstance(IConfigService, {
          get ready() {
            return configReady;
          },
          get: (<T = unknown,>(_domain: string): T => undefined as T) as IConfigService['get'],
        });
        reg.defineInstance(IAgentIdentity, {
          _serviceBrand: undefined,
          resolved: () => identityReady,
          current: () => identitySnapshot,
        });
        reg.defineInstance(IRuntimeResolver, {
          _serviceBrand: undefined,
          inspect: () => runtime,
          acquire: () => ({ runtime, track: (resource) => resource, dispose: () => {} }),
        });
        reg.definePartialInstance(IWorkspaceInstanceManager, { findContaining, getOrCreate });
        reg.defineInstance(ILogService, stubLog());
        reg.define(IMcpManagementService, McpManagementService);
      },
    });
    store = ix.get(IMcpConfigStore);
    management = ix.get(IMcpManagementService);
  });

  afterEach(async () => {
    disposables.dispose();
    await oauth.dispose();
    vi.unstubAllEnvs();
    await Promise.all(httpServers.map((server) => server.close()));
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function startHttpServer(): Promise<{ url: string }> {
    const server = await startInProcessHttpMcpServer();
    httpServers.push(server);
    return server;
  }

  async function startCountingServer(): Promise<{
    url: string;
    requestCount: () => number;
  }> {
    let requests = 0;
    const httpServer: HttpServer = createHttpServer((_req, res) => {
      requests += 1;
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    httpServers.push({
      close: () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err === undefined || err === null ? resolve() : reject(err)));
        }),
    });
    const port = (httpServer.address() as HttpAddress).port;
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      requestCount: () => requests,
    };
  }

  async function startGatedServer(): Promise<{ origin: string; url: string }> {
    const httpServer: HttpServer = createHttpServer((req, res) => {
      if (req.method === 'POST' && req.url === '/token') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="mcp"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    httpServers.push({
      close: () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err === undefined || err === null ? resolve() : reject(err)));
        }),
    });
    const port = (httpServer.address() as HttpAddress).port;
    return { origin: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/mcp` };
  }

  async function startInteractiveAuthServer(): Promise<{ origin: string }> {
    const httpServer: HttpServer = createHttpServer((req, res) => {
      if (req.method !== 'POST' || (req.url !== '/register' && req.url !== '/token')) {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        if (req.url === '/register') {
          const metadata = JSON.parse(body) as Record<string, unknown>;
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ...metadata, client_id: 'test-client' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ access_token: 'fresh-token', token_type: 'Bearer', expires_in: 3600 }),
        );
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    httpServers.push({
      close: () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err === undefined || err === null ? resolve() : reject(err)));
        }),
    });
    const port = (httpServer.address() as HttpAddress).port;
    return { origin: `http://127.0.0.1:${port}` };
  }

  async function seedDiscovery(name: string, url: string, authServerOrigin: string): Promise<void> {
    const provider = oauth.getProvider(name, url);
    await provider.ready;
    await provider.saveDiscoveryState({
      authorizationServerUrl: authServerOrigin,
      authorizationServerMetadata: {
        issuer: authServerOrigin,
        authorization_endpoint: `${authServerOrigin}/authorize`,
        token_endpoint: `${authServerOrigin}/token`,
        registration_endpoint: `${authServerOrigin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
  }

  async function seedClient(name: string, url: string): Promise<void> {
    const provider = oauth.getProvider(name, url);
    await provider.ready;
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
  }

  async function seedTokens(
    name: string,
    url: string,
    tokens: { access_token: string; refresh_token?: string; expires_in?: number },
  ): Promise<void> {
    const provider = oauth.getProvider(name, url);
    await provider.ready;
    await provider.saveTokens({ token_type: 'Bearer', ...tokens });
  }

  async function deliverAuthCallback(authorizationUrl: string): Promise<void> {
    const url = new URL(authorizationUrl);
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    expect(redirectUri).toBeTruthy();
    const callbackUrl = new URL(redirectUri!);
    callbackUrl.searchParams.set('code', 'test-auth-code');
    if (state !== null) callbackUrl.searchParams.set('state', state);
    const response = await fetch(callbackUrl);
    expect(response.status).toBe(200);
    await response.text();
  }

  describe('CRUD', () => {
    it('round-trips add → get → update → remove through the real store and registry', async () => {
      await expect(management.listServers()).resolves.toEqual([]);

      const added = await management.addServer({
        name: 'alpha',
        transport: 'stdio',
        command: 'npx',
        env: { TOKEN: 'abc' },
      });
      expect(added).toEqual([
        {
          name: 'alpha',
          config: { transport: 'stdio', command: 'npx', env: { TOKEN: 'abc' } },
          source: 'global',
          origin: join(home, 'mcp.json'),
          mutable: true,
          plugin: undefined,
        },
      ]);
      await expect(management.getServer('alpha')).resolves.toMatchObject({
        name: 'alpha',
        mutable: true,
        config: { command: 'npx' },
      });

      const updated = await management.updateServer(stdioServer('alpha', 'node'));
      expect(updated).toHaveLength(1);
      expect(updated[0]?.config).toEqual({ transport: 'stdio', command: 'node' });
      await expect(store.get('alpha')).resolves.toMatchObject({ command: 'node' });

      const remaining = await management.removeServer('alpha');
      expect(remaining).toEqual([]);
      await expect(store.list()).resolves.toEqual([]);
    });

    it('waits for live config reconciliation listeners before returning', async () => {
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      store.onDidWrite((event) => {
        resolveStarted();
        event.waitUntil(gate);
      });

      let completed = false;
      const mutation = management.addServer(stdioServer('alpha')).then(() => {
        completed = true;
      });
      await started;
      await Promise.resolve();
      expect(completed).toBe(false);

      release();
      await mutation;
      expect(completed).toBe(true);
    });

    it('normalizes server names so the guard, the persisted key, and the list agree', async () => {
      const added = await management.addServer(stdioServer('  alpha  '));

      expect(added.map((entry) => entry.name)).toEqual(['alpha']);
      await expect(store.get('alpha')).resolves.toMatchObject({ name: 'alpha' });

      const remaining = await management.removeServer('  alpha  ');
      expect(remaining).toEqual([]);
    });

    it('keeps the store duplicate error when re-adding a user-level name', async () => {
      await management.addServer(stdioServer('alpha'));

      await expect(management.addServer(stdioServer('alpha'))).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'MCP server "alpha" already exists',
      });
    });

    it('keeps the store not-found error when updating an unknown server', async () => {
      await expect(management.updateServer(stdioServer('ghost'))).rejects.toMatchObject({
        code: ErrorCodes.MCP_SERVER_NOT_FOUND,
        message: 'MCP server "ghost" was not found',
      });
    });

    it('treats removing an unknown server as a no-op returning the current catalog', async () => {
      await management.addServer(stdioServer('alpha'));

      const remaining = await management.removeServer('ghost');
      expect(remaining.map((entry) => entry.name)).toEqual(['alpha']);
      await expect(store.list()).resolves.toHaveLength(1);
    });
  });

  describe('read-only guards', () => {
    it.each([
      ['add', (cwd: string) => management.addServer(stdioServer('local'), { cwd })],
      ['update', (cwd: string) => management.updateServer(stdioServer('local'), { cwd })],
      ['remove', (cwd: string) => management.removeServer('local', { cwd })],
    ])('rejects %s when a trusted project-layer entry is read-only', async (_operation, mutate) => {
      const project = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-read-only-'));
      tempDirs.push(project);
      await mkdir(join(project, '.kimi-code'), { recursive: true });
      await writeFile(
        join(project, '.kimi-code', 'mcp.json'),
        JSON.stringify({ mcpServers: { local: { command: process.execPath } } }),
        'utf8',
      );

      await expect(mutate(project)).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: `MCP server "local" is read-only: it is defined in ${join(project, '.kimi-code', 'mcp.json')} — edit that file instead`,
      });
      await expect(store.list()).resolves.toEqual([]);
    });

    it('lets a file entry shadow an enabled plugin entry', async () => {
      pluginEntries = [
        {
          name: 'plugin-demo:docs',
          config: { transport: 'http', url: 'https://example.com/mcp' },
          pluginId: 'demo',
          serverName: 'docs',
        },
      ];
      const server: GlobalMcpServerConfig = {
        name: 'plugin-demo:docs',
        transport: 'http',
        url: 'https://example.com/v2',
      };

      const added = await management.addServer(server);
      const matches = added.filter((entry) => entry.name === 'plugin-demo:docs');
      expect(matches).toHaveLength(2);
      expect(matches[0]).toMatchObject({ source: 'global', mutable: true });
      expect(matches[1]).toMatchObject({ source: 'plugin', mutable: false });

      const remaining = await management.removeServer('plugin-demo:docs');
      expect(remaining.filter((entry) => entry.name === 'plugin-demo:docs')).toEqual([
        expect.objectContaining({ source: 'plugin', mutable: false }),
      ]);
      await expect(store.list()).resolves.toEqual([]);
    });

    it('rejects update against an enabled plugin entry that has no file entry yet', async () => {
      pluginEntries = [
        {
          name: 'plugin-demo:docs',
          config: { transport: 'http', url: 'https://example.com/mcp' },
          pluginId: 'demo',
          serverName: 'docs',
        },
      ];

      await expect(
        management.updateServer({
          name: 'plugin-demo:docs',
          transport: 'http',
          url: 'https://example.com/v2',
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.MCP_SERVER_NOT_FOUND });
    });

    it('lets a mutable global entry be maintained past an enabled plugin collision', async () => {
      await store.add(stdioServer('plugin-demo:docs', 'global-version'));
      pluginEntries = [
        {
          name: 'plugin-demo:docs',
          config: { transport: 'http', url: 'https://example.com/mcp' },
          pluginId: 'demo',
          serverName: 'docs',
        },
      ];

      await expect(
        management.addServer(stdioServer('plugin-demo:docs', 'add-version')),
      ).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'MCP server "plugin-demo:docs" already exists',
      });

      await management.updateServer(stdioServer('plugin-demo:docs', 'update-version'));
      await expect(store.get('plugin-demo:docs')).resolves.toMatchObject({
        command: 'update-version',
      });

      const remaining = await management.removeServer('plugin-demo:docs');
      expect(remaining.filter((entry) => entry.name === 'plugin-demo:docs')).toEqual([
        expect.objectContaining({ source: 'plugin', mutable: false }),
      ]);
      await expect(store.list()).resolves.toEqual([]);
    });

    it('never blocks mutations on a disabled plugin descriptor', async () => {
      pluginEntries = [
        {
          name: 'plugin-demo:docs',
          config: { transport: 'http', url: 'https://example.com/mcp', enabled: false },
          pluginId: 'demo',
          serverName: 'docs',
        },
      ];

      const added = await management.addServer({
        name: 'plugin-demo:docs',
        transport: 'http',
        url: 'https://example.com/user',
      });
      const matches = added.filter((entry) => entry.name === 'plugin-demo:docs');
      expect(matches).toHaveLength(2);
      expect(matches[0]).toMatchObject({ source: 'global', mutable: true });
      expect(matches[1]).toMatchObject({ source: 'plugin', mutable: false });

      await management.updateServer({
        name: 'plugin-demo:docs',
        transport: 'http',
        url: 'https://example.com/user-v2',
      });
      await expect(store.get('plugin-demo:docs')).resolves.toMatchObject({
        url: 'https://example.com/user-v2',
      });

      const remaining = await management.removeServer('plugin-demo:docs');
      expect(remaining.filter((entry) => entry.name === 'plugin-demo:docs')).toHaveLength(1);
      expect(remaining[0]).toMatchObject({ source: 'plugin' });
    });
  });

  describe('mutation guard under a degraded registry', () => {
    async function readStoreBytes(): Promise<Uint8Array | undefined> {
      return storage.read(CONFIG_SCOPE, CONFIG_KEY);
    }

    it('aborts add/update/remove without writing when plugin entries fail to load', async () => {
      await management.addServer(stdioServer('alpha'));
      const before = await readStoreBytes();
      pluginError = new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, 'plugin state corrupt');

      await expect(management.addServer(stdioServer('beta'))).rejects.toMatchObject({
        code: ErrorCodes.PLUGIN_LOAD_FAILED,
      });
      await expect(management.updateServer(stdioServer('alpha', 'node'))).rejects.toMatchObject({
        code: ErrorCodes.PLUGIN_LOAD_FAILED,
      });
      await expect(management.removeServer('alpha')).rejects.toMatchObject({
        code: ErrorCodes.PLUGIN_LOAD_FAILED,
      });
      expect(await readStoreBytes()).toEqual(before);
    });

    it('aborts add/update/remove without writing when the user mcp.json is corrupt', async () => {
      const corrupt = textEncoder.encode('{not json');
      await storage.write(CONFIG_SCOPE, CONFIG_KEY, corrupt);

      await expect(management.addServer(stdioServer('alpha'))).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      });
      await expect(management.updateServer(stdioServer('alpha'))).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      });
      await expect(management.removeServer('alpha')).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      });
      expect(await readStoreBytes()).toEqual(corrupt);
    });
  });

  describe('redaction', () => {
    it('redacts secret values of read-only entries while mutable entries keep full values', async () => {
      pluginEntries = [
        {
          name: 'plugin-demo:api',
          config: {
            transport: 'stdio',
            command: 'api-mcp',
            env: { Z_KEY: 'z-value', A_TOKEN: 'a-value' },
          },
          pluginId: 'demo',
          serverName: 'api',
        },
      ];
      await management.addServer({
        name: 'alpha',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer secret' },
      });

      const list = await management.listServers();

      const plugin = list.find((entry) => entry.name === 'plugin-demo:api');
      expect(plugin).toMatchObject({ mutable: false, source: 'plugin' });
      expect(plugin?.config).toMatchObject({ envKeys: ['A_TOKEN', 'Z_KEY'] });
      expect(plugin?.config).not.toHaveProperty('env');
      expect(JSON.stringify(plugin?.config)).not.toContain('a-value');

      const mutable = list.find((entry) => entry.name === 'alpha');
      expect(mutable).toMatchObject({ mutable: true, source: 'global' });
      expect(mutable?.config).toMatchObject({ headers: { Authorization: 'Bearer secret' } });

      const got = await management.getServer('plugin-demo:api');
      expect(got.config).not.toHaveProperty('env');
      expect(got.config).toMatchObject({ envKeys: ['A_TOKEN', 'Z_KEY'] });
    });

    it('lists project-layer entries as read-only redacted views when a cwd is given', async () => {
      const project = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-proj-'));
      tempDirs.push(project);
      await mkdir(join(project, '.kimi-code'), { recursive: true });
      await writeFile(
        join(project, '.kimi-code', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            local: {
              transport: 'http',
              url: 'https://example.com/local',
              headers: { 'X-Key': 'secret' },
            },
          },
        }),
        'utf8',
      );

      const list = await management.listServers({ cwd: project });

      const local = list.find((entry) => entry.name === 'local');
      expect(local).toMatchObject({
        source: 'global',
        mutable: false,
        origin: join(project, '.kimi-code', 'mcp.json'),
      });
      expect(local?.config).toMatchObject({ headerKeys: ['X-Key'] });
      expect(local?.config).not.toHaveProperty('headers');

      const got = await management.getServer('local', { cwd: project });
      expect(got.mutable).toBe(false);
      expect(got.config).not.toHaveProperty('headers');
    });

    it('hides project-layer entries when the workspace is untrusted', async () => {
      const project = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-untrusted-'));
      tempDirs.push(project);
      await mkdir(join(project, '.kimi-code'), { recursive: true });
      await writeFile(
        join(project, '.kimi-code', 'mcp.json'),
        JSON.stringify({ mcpServers: { local: { command: process.execPath } } }),
        'utf8',
      );
      await store.add(stdioServer('user', process.execPath));
      trusted = false;

      const list = await management.listServers({ cwd: project });

      expect(list.map((entry) => entry.name)).toEqual(['user']);
      await expect(management.getServer('local', { cwd: project })).rejects.toMatchObject({
        code: ErrorCodes.MCP_SERVER_NOT_FOUND,
      });
      expect(getOrCreate).not.toHaveBeenCalled();
    });
  });

  describe('testServer', () => {
    it('probes an inline unsaved http config without touching the store', async () => {
      const server = await startHttpServer();

      const result = await management.testServer({
        server: { name: 'unsaved-probe', transport: 'http', url: server.url },
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Connected to MCP server "unsaved-probe".');
      expect(result.output).toContain('Available tools: 1');
      expect(result.output).toContain('- echo: Echoes text');
      expect(getOrCreate).not.toHaveBeenCalled();
      await expect(store.list()).resolves.toEqual([]);
    }, 20000);

    it('reports a clean failure for an unreachable inline http server', async () => {
      const result = await management.testServer({
        server: {
          name: 'down',
          transport: 'http',
          url: 'http://127.0.0.1:1/mcp',
          startupTimeoutMs: 5_000,
        },
      });

      expect(result.success).toBe(false);
      expect(result.output.length).toBeGreaterThan(0);
      await expect(store.list()).resolves.toEqual([]);
    }, 20000);

    it('probes an inline stdio config without retaining the probe cwd workspace', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-cwd-'));
      tempDirs.push(cwd);

      const result = await management.testServer({
        server: {
          name: 'stdio-probe',
          transport: 'stdio',
          command: process.execPath,
          args: [stdioFixture],
        },
        cwd,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Available tools: 4');
      expect(result.output).toContain('- echo: Echoes input text');
      expect(findContaining).toHaveBeenCalledWith(cwd);
      expect(getOrCreate).not.toHaveBeenCalled();
    }, 20000);

    it('probes a nested cwd against the containing workspace runtimes', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-nested-'));
      tempDirs.push(cwd);
      findContaining.mockReturnValue({ id: 'test-workspace' } as unknown as WorkspaceInstance);

      const result = await management.testServer({
        server: {
          name: 'stdio-probe',
          transport: 'stdio',
          command: process.execPath,
          args: [stdioFixture],
        },
        cwd,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Available tools: 4');
      expect(findContaining).toHaveBeenCalledWith(cwd);
      expect(getOrCreate).not.toHaveBeenCalled();
    }, 20000);

    it('rejects a non-local runtime_id probe when no workspace contains the cwd', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-remote-miss-'));
      tempDirs.push(cwd);

      await expect(
        management.testServer({
          server: {
            name: 'stdio-probe',
            transport: 'stdio',
            command: process.execPath,
            args: [stdioFixture],
            runtime_id: 'remote',
          },
          cwd,
        }),
      ).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: expect.stringContaining('runtime_id "remote"'),
      });
      expect(findContaining).toHaveBeenCalledWith(cwd);
      expect(getOrCreate).not.toHaveBeenCalled();
    });

    it('probes a non-local runtime_id through the containing workspace', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-remote-hit-'));
      tempDirs.push(cwd);
      findContaining.mockReturnValue({ id: 'test-workspace' } as unknown as WorkspaceInstance);

      const result = await management.testServer({
        server: {
          name: 'stdio-probe',
          transport: 'stdio',
          command: process.execPath,
          args: [stdioFixture],
          runtime_id: 'remote',
        },
        cwd,
      });

      expect(result.success).toBe(true);
      expect(findContaining).toHaveBeenCalledWith(cwd);
      expect(getOrCreate).not.toHaveBeenCalled();
    }, 20000);

    it('keeps the transient local probe for an explicit local runtime_id', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-local-explicit-'));
      tempDirs.push(cwd);

      const result = await management.testServer({
        server: {
          name: 'stdio-probe',
          transport: 'stdio',
          command: process.execPath,
          args: [stdioFixture],
          runtime_id: 'local',
        },
        cwd,
      });

      expect(result.success).toBe(true);
      expect(findContaining).toHaveBeenCalledWith(cwd);
      expect(getOrCreate).not.toHaveBeenCalled();
    }, 20000);

    it('rejects an inline probe whose name disagrees with the server config', async () => {
      await expect(
        management.testServer({ name: 'other', server: stdioServer('inline') }),
      ).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'Pass either an MCP server name or an inline server config, not both',
      });
      await expect(management.testServer({})).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'Pass an MCP server name or an inline server config',
      });
    });

    it('rejects a name-only probe for an unknown server', async () => {
      await expect(management.testServer({ name: 'ghost' })).rejects.toMatchObject({
        code: ErrorCodes.MCP_SERVER_NOT_FOUND,
        message: 'MCP server "ghost" was not found',
      });
    });

    it('does not execute a project server while the workspace is untrusted', async () => {
      const project = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-untrusted-probe-'));
      tempDirs.push(project);
      await mkdir(join(project, '.kimi-code'), { recursive: true });
      await writeFile(
        join(project, '.kimi-code', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            local: { command: process.execPath, args: [stdioFixture] },
          },
        }),
        'utf8',
      );
      trusted = false;

      await expect(management.testServer({ name: 'local', cwd: project })).rejects.toMatchObject({
        code: ErrorCodes.MCP_SERVER_NOT_FOUND,
      });
    });

    it('waits for config and identity readiness before starting a probe', async () => {
      let releaseConfig: () => void = () => undefined;
      configReady = new Promise<void>((resolve) => {
        releaseConfig = resolve;
      });
      let releaseIdentity: () => void = () => undefined;
      identityReady = new Promise<AgentIdentitySnapshot>((resolve) => {
        releaseIdentity = () => resolve(identitySnapshot);
      });
      const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-ready-'));
      tempDirs.push(cwd);

      const probe = management.testServer({
        server: {
          name: 'stdio-probe',
          transport: 'stdio',
          command: process.execPath,
          args: [stdioFixture],
        },
        cwd,
      });
      await Promise.resolve();
      expect(findContaining).not.toHaveBeenCalled();

      releaseConfig();
      await Promise.resolve();
      expect(findContaining).not.toHaveBeenCalled();

      releaseIdentity();
      await expect(probe).resolves.toMatchObject({ success: true });
      expect(findContaining).toHaveBeenCalledWith(cwd);
      expect(getOrCreate).not.toHaveBeenCalled();
    }, 20000);

    it('rejects a name-only probe under an enabled runtime-name collision', async () => {
      pluginEntries = [
        {
          name: 'plugin-demo:api',
          config: { transport: 'http', url: 'https://example.com/plugin' },
          pluginId: 'demo',
          serverName: 'api',
        },
      ];
      await store.add({
        name: 'plugin-demo:api',
        transport: 'http',
        url: 'https://example.com/user',
      });

      await expect(management.testServer({ name: 'plugin-demo:api' })).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'MCP runtime name "plugin-demo:api" is shared by multiple enabled servers',
      });
    });

    it('probes the sole enabled entry when the name collides with a disabled shadow', async () => {
      const server = await startHttpServer();
      pluginEntries = [
        {
          name: 'plugin-demo:api',
          config: { transport: 'http', url: server.url },
          pluginId: 'demo',
          serverName: 'api',
        },
      ];
      await store.add({
        name: 'plugin-demo:api',
        transport: 'http',
        url: 'http://127.0.0.1:1/unreachable',
        enabled: false,
      });

      const result = await management.testServer({ name: 'plugin-demo:api' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('echo');
    }, 20000);

    it('probes a plugin server by name', async () => {
      const server = await startHttpServer();
      pluginEntries = [
        {
          name: 'plugin-demo:api',
          config: { transport: 'http', url: server.url },
          pluginId: 'demo',
          serverName: 'api',
        },
      ];

      const result = await management.testServer({ name: 'plugin-demo:api' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Connected to MCP server "plugin-demo:api".');
      expect(result.output).toContain('echo');
    }, 20000);
  });

  describe('listAuthStatuses', () => {
    it('classifies stored grants offline without probing', async () => {
      await management.addServer({
        name: 'stale',
        transport: 'http',
        url: 'https://stale.example.test/mcp',
        auth: 'oauth',
      });
      await management.addServer({
        name: 'refreshable',
        transport: 'http',
        url: 'https://refresh.example.test/mcp',
        auth: 'oauth',
      });
      await management.addServer({
        name: 'fresh',
        transport: 'http',
        url: 'https://fresh.example.test/mcp',
        auth: 'oauth',
      });
      await management.addServer({
        name: 'bearer',
        transport: 'http',
        url: 'https://bearer.example.test/mcp',
        bearerTokenEnvVar: 'API_TOKEN',
      });
      await management.addServer(stdioServer('local-tool'));
      await seedTokens('stale', 'https://stale.example.test/mcp', {
        access_token: 'dead',
        expires_in: -60,
      });
      await seedTokens('refreshable', 'https://refresh.example.test/mcp', {
        access_token: 'old',
        refresh_token: 'still-good',
        expires_in: -60,
      });
      await seedTokens('fresh', 'https://fresh.example.test/mcp', {
        access_token: 'good',
        expires_in: 3600,
      });

      await expect(management.listAuthStatuses()).resolves.toEqual([
        { name: 'stale', authStatus: 'oauth-expired' },
        { name: 'refreshable', authStatus: 'oauth-authorized' },
        { name: 'fresh', authStatus: 'oauth-authorized' },
        { name: 'bearer', authStatus: 'bearer-token' },
        { name: 'local-tool', authStatus: 'not-applicable' },
      ]);
    });

    it('short-circuits disabled servers even under online verification', async () => {
      await management.addServer({
        name: 'off',
        transport: 'http',
        url: 'https://disabled.example.test/mcp',
        auth: 'oauth',
        enabled: false,
      });

      await expect(management.listAuthStatuses({ verify: true })).resolves.toEqual([
        { name: 'off', authStatus: 'not-applicable' },
      ]);
    });

    it('classifies unpinned servers without a stored grant offline when verify is false', async () => {
      const server = await startCountingServer();
      await management.addServer({ name: 'plain', transport: 'http', url: server.url });
      await management.addServer({
        name: 'challenged',
        transport: 'http',
        url: 'https://challenged.example.test/mcp',
        auth: 'oauth',
      });

      await expect(management.listAuthStatuses({ verify: false })).resolves.toEqual([
        { name: 'plain', authStatus: 'not-applicable' },
        { name: 'challenged', authStatus: 'oauth-required' },
      ]);
      expect(server.requestCount()).toBe(0);
    }, 20000);

    it('detects an implicit OAuth challenge when verify is omitted', async () => {
      const gated = await startGatedServer();
      await management.addServer({ name: 'detected', transport: 'http', url: gated.url });

      await expect(management.listAuthStatuses()).resolves.toEqual([
        { name: 'detected', authStatus: 'oauth-required' },
      ]);
    }, 20000);

    it('verify settles a stored-but-rejected grant as oauth-expired through a real probe', async () => {
      const gated = await startGatedServer();
      await management.addServer({
        name: 'stale',
        transport: 'http',
        url: gated.url,
        auth: 'oauth',
      });
      await seedDiscovery('stale', gated.url, gated.origin);
      await seedClient('stale', gated.url);
      await seedTokens('stale', gated.url, {
        access_token: 'wrong',
        refresh_token: 'dead-refresh',
      });

      await expect(management.listAuthStatuses({ verify: true })).resolves.toEqual([
        { name: 'stale', authStatus: 'oauth-expired' },
      ]);
    }, 20000);
  });

  describe('inspectServers', () => {
    it('includes trusted project-layer entries when cwd is provided', async () => {
      const project = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-inspect-project-'));
      tempDirs.push(project);
      await mkdir(join(project, '.kimi-code'), { recursive: true });
      await writeFile(
        join(project, '.kimi-code', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            local: {
              transport: 'http',
              url: 'https://project.example.test/mcp',
              headers: { 'X-Key': 'secret' },
            },
          },
        }),
        'utf8',
      );

      const inspections = await management.inspectServers(undefined, { cwd: project });

      expect(inspections).toEqual([
        expect.objectContaining({
          serverId: 'global:local',
          runtimeName: 'local',
          canonicalUrl: 'https://project.example.test/mcp',
          editable: false,
          authStatus: 'not-applicable',
        }),
      ]);
    });

    it('lists the locator-addressed catalog with offline classifications and redacted configs', async () => {
      const plain = await startHttpServer();
      await management.addServer({ name: 'plain', transport: 'http', url: plain.url });
      await management.addServer(stdioServer('local-tool'));
      await management.addServer({
        name: 'bearer',
        transport: 'http',
        url: 'https://bearer.example.test/mcp',
        bearerTokenEnvVar: 'API_TOKEN',
      });
      await management.addServer({
        name: 'off',
        transport: 'http',
        url: 'https://off.example.test/mcp',
        enabled: false,
      });
      pluginEntries = [
        {
          name: 'plugin-demo:api',
          config: { transport: 'http', url: plain.url, headers: { 'X-Key': 'secret' } },
          pluginId: 'demo',
          serverName: 'api',
        },
      ];

      const inspections = await management.inspectServers();
      const byId = new Map(inspections.map((server) => [server.serverId, server]));
      expect([...byId.keys()].toSorted()).toEqual([
        'global:bearer',
        'global:local-tool',
        'global:off',
        'global:plain',
        'plugin:demo:api',
      ]);

      expect(byId.get('global:plain')).toMatchObject({
        locator: { source: 'global', name: 'plain' },
        runtimeName: 'plain',
        canonicalUrl: plain.url,
        origin: 'global',
        enabled: true,
        editable: true,
        authStatus: 'not-applicable',
      });
      expect(byId.get('global:local-tool')).toMatchObject({
        canonicalUrl: undefined,
        authStatus: 'not-applicable',
      });
      expect(byId.get('global:bearer')).toMatchObject({ authStatus: 'bearer-token' });
      expect(byId.get('global:off')).toMatchObject({
        enabled: false,
        authStatus: 'not-applicable',
      });
      const plugin = byId.get('plugin:demo:api');
      expect(plugin).toMatchObject({
        locator: { source: 'plugin', pluginId: 'demo', serverName: 'api' },
        runtimeName: 'plugin-demo:api',
        canonicalUrl: plain.url,
        origin: 'plugin',
        enabled: true,
        editable: false,
        authStatus: 'not-applicable',
      });
      expect(plugin?.config).toMatchObject({ headerKeys: ['X-Key'] });
      expect(plugin?.config).not.toHaveProperty('headers');
      expect(JSON.stringify(plugin?.config)).not.toContain('secret');
    }, 20000);

    it('marks a runtime-name collision as unavailable instead of probing it', async () => {
      const plain = await startHttpServer();
      pluginEntries = [
        {
          name: 'plugin-demo:api',
          config: { transport: 'http', url: plain.url },
          pluginId: 'demo',
          serverName: 'api',
        },
      ];
      await store.add({ name: 'plugin-demo:api', transport: 'http', url: plain.url });

      const targeted = await management.inspectServers([
        { source: 'plugin', pluginId: 'demo', serverName: 'api' },
      ]);
      expect(targeted).toHaveLength(1);
      expect(targeted[0]).toMatchObject({
        runtimeName: 'plugin-demo:api',
        authStatus: 'unavailable',
        error: 'MCP runtime name "plugin-demo:api" is not unique',
      });

      const all = await management.inspectServers();
      expect(all.filter((server) => server.runtimeName === 'plugin-demo:api')).toHaveLength(2);
    }, 20000);

    it('settles needs-auth probes by their stored grant: expired with one, required without', async () => {
      const gated = await startGatedServer();
      await management.addServer({
        name: 'stale',
        transport: 'http',
        url: gated.url,
        auth: 'oauth',
      });
      await management.addServer({
        name: 'challenged',
        transport: 'http',
        url: `${gated.origin}/other`,
        auth: 'oauth',
      });
      await seedDiscovery('stale', gated.url, gated.origin);
      await seedClient('stale', gated.url);
      await seedTokens('stale', gated.url, {
        access_token: 'wrong',
        refresh_token: 'dead-refresh',
      });
      await seedDiscovery('challenged', `${gated.origin}/other`, gated.origin);
      await seedClient('challenged', `${gated.origin}/other`);

      const inspections = await management.inspectServers();
      const byName = new Map(inspections.map((server) => [server.runtimeName, server]));

      expect(byName.get('stale')).toMatchObject({ authStatus: 'oauth-expired' });
      expect(byName.get('challenged')).toMatchObject({ authStatus: 'oauth-required' });
    }, 20000);

    it('rejects unknown locators with the shared not-found error', async () => {
      await expect(
        management.inspectServers([{ source: 'global', name: 'missing' }]),
      ).rejects.toMatchObject({
        code: ErrorCodes.MCP_SERVER_NOT_FOUND,
        message: 'MCP server "missing" was not found',
      });
      await expect(
        management.inspectServers([{ source: 'plugin', pluginId: 'demo', serverName: 'ghost' }]),
      ).rejects.toMatchObject({
        code: ErrorCodes.MCP_SERVER_NOT_FOUND,
        message: 'MCP server "demo/ghost" was not found',
      });
    });
  });

  describe('resolveServerByName', () => {
    it('resolves a project-layer-only name when cwd is provided', async () => {
      const project = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-resolve-project-'));
      tempDirs.push(project);
      await mkdir(join(project, '.kimi-code'), { recursive: true });
      await writeFile(
        join(project, '.kimi-code', 'mcp.json'),
        JSON.stringify({ mcpServers: { local: { command: process.execPath } } }),
        'utf8',
      );

      await expect(management.resolveServerByName('local', { cwd: project })).resolves.toEqual({
        source: 'global',
        name: 'local',
      });
    });

    it('resolves a unique global name to its locator', async () => {
      await management.addServer(stdioServer('alpha'));

      await expect(management.resolveServerByName('alpha')).resolves.toEqual({
        source: 'global',
        name: 'alpha',
      });
    });

    it('resolves the sole enabled owner past a disabled shadow', async () => {
      pluginEntries = [
        {
          name: 'plugin-demo:api',
          config: { transport: 'http', url: 'https://example.com/mcp' },
          pluginId: 'demo',
          serverName: 'api',
        },
      ];
      await store.add({
        name: 'plugin-demo:api',
        transport: 'http',
        url: 'https://example.com/user',
        enabled: false,
      });

      await expect(management.resolveServerByName('plugin-demo:api')).resolves.toEqual({
        source: 'plugin',
        pluginId: 'demo',
        serverName: 'api',
      });
    });

    it('rejects an unknown name with the shared not-found error', async () => {
      await expect(management.resolveServerByName('ghost')).rejects.toMatchObject({
        code: ErrorCodes.MCP_SERVER_NOT_FOUND,
        message: 'MCP server "ghost" was not found',
      });
    });

    it('rejects a name shared by enabled entries, pointing at the locator RPC', async () => {
      pluginEntries = [
        {
          name: 'plugin-demo:api',
          config: { transport: 'http', url: 'https://example.com/mcp' },
          pluginId: 'demo',
          serverName: 'api',
        },
      ];
      await store.add({
        name: 'plugin-demo:api',
        transport: 'http',
        url: 'https://example.com/user',
      });

      await expect(management.resolveServerByName('plugin-demo:api')).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message:
          'MCP runtime name "plugin-demo:api" is shared by multiple enabled servers; use the locator-addressed RPC instead',
      });
    });
  });

  describe('OAuth operations', () => {
    it('begins authorization against the project-layer URL when cwd is provided', async () => {
      const project = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-begin-project-'));
      tempDirs.push(project);
      await mkdir(join(project, '.kimi-code'), { recursive: true });
      await writeFile(
        join(project, '.kimi-code', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            oauthable: {
              transport: 'http',
              url: 'https://project.example.test/mcp',
              auth: 'oauth',
            },
          },
        }),
        'utf8',
      );
      const cancel = vi.fn(async () => undefined);
      const begin = vi.spyOn(oauth, 'beginAuthorization').mockResolvedValue({
        authorizationUrl: new URL('https://project.example.test/authorize'),
        complete: vi.fn(async () => undefined),
        cancel,
      });

      const result = await management.beginServerAuth(
        { source: 'global', name: 'oauthable' },
        { cwd: project },
      );

      expect(begin).toHaveBeenCalledWith('oauthable', 'https://project.example.test/mcp');
      if (result.status === 'authorization-required') {
        await management.cancelServerAuth({ flowId: result.flowId });
      }
    });

    it('resets credentials for the project-layer URL when cwd is provided', async () => {
      const project = mkdtempSync(join(tmpdir(), 'kimi-mcp-management-reset-project-'));
      tempDirs.push(project);
      await mkdir(join(project, '.kimi-code'), { recursive: true });
      await writeFile(
        join(project, '.kimi-code', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            oauthable: {
              transport: 'http',
              url: 'https://project.example.test/mcp',
              auth: 'oauth',
            },
          },
        }),
        'utf8',
      );
      const invalidate = vi.spyOn(oauth, 'invalidate').mockResolvedValue(undefined);

      await management.resetServerAuth(
        { source: 'global', name: 'oauthable' },
        { cwd: project },
      );

      expect(invalidate).toHaveBeenCalledWith(
        'oauthable',
        'https://project.example.test/mcp',
      );
    });

    it('rejects begin for entries that cannot run an OAuth flow', async () => {
      await management.addServer(stdioServer('local-tool'));
      await management.addServer({
        name: 'bearer',
        transport: 'http',
        url: 'https://bearer.example.test/mcp',
        bearerTokenEnvVar: 'API_TOKEN',
      });
      await management.addServer({
        name: 'static-headers',
        transport: 'http',
        url: 'https://static.example.test/mcp',
        headers: { 'X-Key': 'v' },
      });

      await expect(
        management.beginServerAuth({ source: 'global', name: 'local-tool' }),
      ).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'MCP server "local-tool" does not use a remote transport',
      });
      await expect(
        management.beginServerAuth({ source: 'global', name: 'bearer' }),
      ).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'MCP server "bearer" uses a static bearer token',
      });
      await expect(
        management.beginServerAuth({ source: 'global', name: 'static-headers' }),
      ).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'MCP server "static-headers" uses static headers and is not marked for OAuth',
      });
      await expect(
        management.beginServerAuth({ source: 'global', name: 'missing' }),
      ).rejects.toMatchObject({ code: ErrorCodes.MCP_SERVER_NOT_FOUND });
    });

    it('refuses credential operations under an enabled runtime-name collision', async () => {
      pluginEntries = [
        {
          name: 'plugin-demo:api',
          config: { transport: 'http', url: 'https://example.com/mcp', auth: 'oauth' },
          pluginId: 'demo',
          serverName: 'api',
        },
      ];
      await store.add({
        name: 'plugin-demo:api',
        transport: 'http',
        url: 'https://example.com/user',
        auth: 'oauth',
      });

      const ambiguous = {
        code: ErrorCodes.REQUEST_INVALID,
        message:
          'MCP runtime name "plugin-demo:api" is shared by multiple enabled servers; use the locator-addressed RPC instead',
      };
      await expect(
        management.beginServerAuth({ source: 'plugin', pluginId: 'demo', serverName: 'api' }),
      ).rejects.toMatchObject(ambiguous);
      await expect(
        management.resetServerAuth({ source: 'global', name: 'plugin-demo:api' }),
      ).rejects.toMatchObject(ambiguous);
    });

    it('returns already-authorized when a valid grant is stored', async () => {
      const authServer = await startInteractiveAuthServer();
      const mcpUrl = `${authServer.origin}/mcp`;
      await management.addServer({
        name: 'oauthable',
        transport: 'http',
        url: mcpUrl,
        auth: 'oauth',
      });
      await seedDiscovery('oauthable', mcpUrl, authServer.origin);
      await seedTokens('oauthable', mcpUrl, {
        access_token: 'stale-access',
        refresh_token: 'good-refresh',
      });

      await expect(
        management.beginServerAuth({ source: 'global', name: 'oauthable' }),
      ).resolves.toEqual({ status: 'already-authorized' });
    }, 20000);

    it('drives a full browser flow: begin → callback → complete → tokens persisted', async () => {
      const authServer = await startInteractiveAuthServer();
      const mcpUrl = `${authServer.origin}/mcp`;
      await management.addServer({
        name: 'oauthable',
        transport: 'http',
        url: mcpUrl,
        auth: 'oauth',
      });
      await seedDiscovery('oauthable', mcpUrl, authServer.origin);
      const events: McpOAuthEvent[] = [];
      oauth.onEvent((event) => events.push(event));

      const begun = await management.beginServerAuth({ source: 'global', name: 'oauthable' });
      if (begun.status !== 'authorization-required') {
        throw new Error(`expected authorization-required, got ${begun.status}`);
      }
      expect(begun.authorizationUrl).toContain(`${authServer.origin}/authorize`);

      const completing = management.completeServerAuth({
        flowId: begun.flowId,
        timeoutMs: 10_000,
      });
      await deliverAuthCallback(begun.authorizationUrl);
      await completing;

      expect((await oauth.tokenState('oauthable', mcpUrl)).hasTokens).toBe(true);
      expect(events).toContainEqual({
        type: 'tokens-saved',
        serverName: 'oauthable',
        serverUrl: mcpUrl,
      });
    }, 20000);

    it('cancel tears down an active flow, so a later complete rejects as unknown', async () => {
      const authServer = await startInteractiveAuthServer();
      const mcpUrl = `${authServer.origin}/mcp`;
      await management.addServer({
        name: 'oauthable',
        transport: 'http',
        url: mcpUrl,
        auth: 'oauth',
      });
      await seedDiscovery('oauthable', mcpUrl, authServer.origin);

      const begun = await management.beginServerAuth({ source: 'global', name: 'oauthable' });
      if (begun.status !== 'authorization-required') {
        throw new Error(`expected authorization-required, got ${begun.status}`);
      }

      await management.cancelServerAuth({ flowId: begun.flowId });

      await expect(
        management.completeServerAuth({ flowId: begun.flowId, timeoutMs: 1000 }),
      ).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: `Unknown MCP OAuth flow: ${begun.flowId}`,
      });
    }, 20000);

    it('keeps a joined flow usable when an earlier flow handle is cancelled', async () => {
      const authServer = await startInteractiveAuthServer();
      const mcpUrl = `${authServer.origin}/mcp`;
      await management.addServer({
        name: 'oauthable',
        transport: 'http',
        url: mcpUrl,
        auth: 'oauth',
      });
      await seedDiscovery('oauthable', mcpUrl, authServer.origin);

      const first = await management.beginServerAuth({ source: 'global', name: 'oauthable' });
      const second = await management.beginServerAuth({ source: 'global', name: 'oauthable' });
      if (
        first.status !== 'authorization-required' ||
        second.status !== 'authorization-required'
      ) {
        throw new Error('expected both flows to require authorization');
      }
      expect(second.authorizationUrl).toBe(first.authorizationUrl);

      await management.cancelServerAuth({ flowId: first.flowId });
      const completing = management.completeServerAuth({
        flowId: second.flowId,
        timeoutMs: 10_000,
      });
      await deliverAuthCallback(second.authorizationUrl);
      await completing;

      expect((await oauth.tokenState('oauthable', mcpUrl)).hasTokens).toBe(true);
    }, 20000);

    it('expires an idle flow: the flow is cancelled and a later complete rejects as unknown', async () => {
      await management.addServer({
        name: 'oauthable',
        transport: 'http',
        url: 'https://oauthable.example.test/mcp',
        auth: 'oauth',
      });
      const cancel = vi.fn(async () => undefined);
      const beginSpy = vi.spyOn(oauth, 'beginAuthorization').mockResolvedValue({
        authorizationUrl: new URL('https://oauthable.example.test/authorize'),
        complete: vi.fn(async () => undefined),
        cancel,
      });
      vi.useFakeTimers();
      try {
        const begun = await management.beginServerAuth({ source: 'global', name: 'oauthable' });
        if (begun.status !== 'authorization-required') {
          throw new Error(`expected authorization-required, got ${begun.status}`);
        }

        await vi.advanceTimersByTimeAsync(15 * 60_000);

        expect(cancel).toHaveBeenCalledTimes(1);
        await expect(
          management.completeServerAuth({ flowId: begun.flowId, timeoutMs: 1000 }),
        ).rejects.toMatchObject({
          code: ErrorCodes.REQUEST_INVALID,
          message: `Unknown MCP OAuth flow: ${begun.flowId}`,
        });
      } finally {
        vi.useRealTimers();
        beginSpy.mockRestore();
      }
    });

    it('complete rejects on timeout when the browser callback never arrives', async () => {
      const authServer = await startInteractiveAuthServer();
      const mcpUrl = `${authServer.origin}/mcp`;
      await management.addServer({
        name: 'oauthable',
        transport: 'http',
        url: mcpUrl,
        auth: 'oauth',
      });
      await seedDiscovery('oauthable', mcpUrl, authServer.origin);

      const begun = await management.beginServerAuth({ source: 'global', name: 'oauthable' });
      if (begun.status !== 'authorization-required') {
        throw new Error(`expected authorization-required, got ${begun.status}`);
      }

      await expect(
        management.completeServerAuth({ flowId: begun.flowId, timeoutMs: 200 }),
      ).rejects.toThrow(/OAuth callback timed out/);
    }, 20000);

    it('complete rejects an unknown flow while cancel ignores it', async () => {
      await expect(management.completeServerAuth({ flowId: 'unknown-flow' })).rejects.toMatchObject(
        {
          code: ErrorCodes.REQUEST_INVALID,
          message: 'Unknown MCP OAuth flow: unknown-flow',
        },
      );
      await expect(management.cancelServerAuth({ flowId: 'unknown-flow' })).resolves.toBeUndefined();
    });

    it('complete rejects a timeoutMs outside the setTimeout range', async () => {
      await expect(
        management.completeServerAuth({ flowId: 'unknown-flow', timeoutMs: 2 ** 31 }),
      ).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'MCP OAuth timeoutMs must be an integer between 1 and 2147483647',
      });
      await expect(
        management.completeServerAuth({ flowId: 'unknown-flow', timeoutMs: 0 }),
      ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      await expect(
        management.completeServerAuth({ flowId: 'unknown-flow', timeoutMs: 1.5 }),
      ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    });

    it('reset invalidates stored credentials and broadcasts the event', async () => {
      await management.addServer({
        name: 'oauthable',
        transport: 'http',
        url: 'https://oauth.example.test/mcp',
        auth: 'oauth',
      });
      await seedTokens('oauthable', 'https://oauth.example.test/mcp', {
        access_token: 'good',
        expires_in: 3600,
      });
      const events: McpOAuthEvent[] = [];
      oauth.onEvent((event) => events.push(event));

      await management.resetServerAuth({ source: 'global', name: 'oauthable' });

      expect((await oauth.tokenState('oauthable', 'https://oauth.example.test/mcp')).hasTokens).toBe(
        false,
      );
      expect(events).toContainEqual({
        type: 'tokens-invalidated',
        serverName: 'oauthable',
        serverUrl: 'https://oauth.example.test/mcp',
        scope: 'all',
      });
    });

    it('resets a plugin server by locator', async () => {
      pluginEntries = [
        {
          name: 'plugin-demo:api',
          config: { transport: 'http', url: 'https://example.com/mcp', auth: 'oauth' },
          pluginId: 'demo',
          serverName: 'api',
        },
      ];

      await expect(
        management.resetServerAuth({ source: 'plugin', pluginId: 'demo', serverName: 'api' }),
      ).resolves.toBeUndefined();
    });

    it('rejects reset for a stdio locator', async () => {
      await management.addServer(stdioServer('local-tool'));

      await expect(
        management.resetServerAuth({ source: 'global', name: 'local-tool' }),
      ).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'MCP server "local-tool" does not use a remote transport',
      });
    });
  });
});
