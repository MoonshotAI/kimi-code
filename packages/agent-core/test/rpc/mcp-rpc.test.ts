/**
 * Scenario: the unified MCP management plane on KimiCore — the registry-backed
 * global view (global + plugin sources, read-only gating, effective configs),
 * the extended interfaces (inline-config probe, session-level add), and the
 * push of config / plugin / credential changes into live sessions.
 *
 * Run with `pnpm --filter @moonshot-ai/agent-core exec vitest run test/rpc/mcp-rpc.test.ts`.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';
import { setTimeout as sleep } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { McpOAuthService } from '../../src/mcp/oauth';
import type { ApprovalResponse, CoreAPI, SDKAPI } from '../../src/rpc';
import { createRPC } from '../../src/rpc';
import { KimiCore } from '../../src/rpc/core-impl';

const STDIO_FIXTURE = join(import.meta.dirname, '../mcp/fixtures/mock-stdio-server.mjs');

const cleanups: Array<() => Promise<void> | void> = [];
const cores: KimiCore[] = [];
afterEach(async () => {
  // Sessions hold keep-alive MCP connections; they must go down before the
  // fixture servers close, and before any token endpoints disappear.
  for (const core of cores.splice(0)) {
    for (const sessionId of [...core.sessions.keys()]) {
      await core.closeSession({ sessionId }).catch(() => undefined);
    }
  }
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

function baseModelConfig(): string {
  return `default_model = "default-mock"

[providers.test]
type = "kimi"
api_key = "test-key"

[models."default-mock"]
provider = "test"
model = "default-mock"
max_context_size = 100000
`;
}

async function makePlugin(name: string, mcpServers: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `kimi-mcp-rpc-plugin-`));
  await writeJson(join(root, 'kimi.plugin.json'), { name, mcpServers });
  return realpath(root);
}

interface CoreFixture {
  readonly core: KimiCore;
  readonly rpc: Awaited<ReturnType<ReturnType<typeof createRPC<CoreAPI, SDKAPI>>[1]>>;
  readonly home: string;
  readonly workDir: string;
}

async function makeCore(seed?: (home: string) => Promise<void>): Promise<CoreFixture> {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'kimi-mcp-rpc-')));
  const home = join(tmp, 'home');
  const workDir = join(tmp, 'work');
  await mkdir(home, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(join(home, 'config.toml'), baseModelConfig());
  await seed?.(home);

  const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
  const core = new KimiCore(coreRpc, { homeDir: home });
  cores.push(core);
  const rpc = await sdkRpc({
    emitEvent: vi.fn(),
    requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '' })),
  });
  return { core, rpc, home, workDir };
}

/** In-process MCP HTTP server, optionally gated behind a static bearer token. */
async function startMcpHttpServer(
  options: { readonly bearerToken?: string; readonly oauthRejecting?: boolean } = {},
): Promise<{
  readonly url: string;
}> {
  // Stateless per-request transports: reconnect cycles (plugin sync, OAuth
  // reconnect) must each get a fresh server-side session.
  const httpServer: HttpServer = createHttpServer((req, res) => {
    const baseUrl = `http://127.0.0.1:${(httpServer.address() as HttpAddress).port}`;
    if (options.oauthRejecting === true) {
      // Minimal OAuth discovery + a token endpoint that always rejects, so a
      // stale grant's refresh attempt fails deterministically and the client
      // lands on needs-auth instead of a generic connection failure.
      if (req.url === '/.well-known/oauth-protected-resource') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl] }));
        return;
      }
      if (req.url === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
          }),
        );
        return;
      }
      if (req.url === '/register' && req.method === 'POST') {
        void (async () => {
          let body = '';
          for await (const chunk of req) body += chunk;
          // Echo the request metadata back: the SDK validates the full client
          // information (redirect_uris must come back).
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ client_id: 'mgmt-fixture-client', ...JSON.parse(body) }));
        })().catch(() => res.destroy());
        return;
      }
      if (req.url === '/token' && req.method === 'POST') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
    }
    if (
      options.bearerToken !== undefined &&
      req.headers.authorization !== `Bearer ${options.bearerToken}`
    ) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer realm="mcp", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    void (async () => {
      const mcpServer = new McpServer({ name: 'mgmt-fixture', version: '0.0.1' });
      mcpServer.registerTool(
        'echo',
        { description: 'Echoes text', inputSchema: { text: z.string() } },
        ({ text }) => ({ content: [{ type: 'text', text }] }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
      await transport.handleRequest(req, res);
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  );
  const port = (httpServer.address() as HttpAddress).port;
  return { url: `http://127.0.0.1:${port}/mcp` };
}

/** The core's process-wide OAuth service (private; tests reach in on purpose). */
function coreOAuth(core: KimiCore): McpOAuthService {
  return (core as unknown as { mcpOAuth: McpOAuthService }).mcpOAuth;
}

describe('KimiCore unified MCP management plane', () => {
  it('lists global and plugin servers in one registry-backed view', async () => {
    const { core, home } = await makeCore();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { fs: { command: 'fs-mcp' } },
    });
    const pluginRoot = await makePlugin('demo', {
      docs: { transport: 'http', url: 'https://example.com/mcp' },
    });
    await core.installPlugin({ source: pluginRoot });

    const list = await core.listGlobalMcpServers({});
    const byName = new Map(list.map((entry) => [entry.name, entry]));
    expect(byName.get('fs')).toMatchObject({
      source: 'global',
      mutable: true,
      origin: join(home, 'mcp.json'),
    });
    expect(byName.get('plugin-demo:docs')).toMatchObject({
      source: 'plugin',
      mutable: false,
      origin: 'demo',
      plugin: { id: 'demo', name: 'docs' },
      url: 'https://example.com/mcp',
    });

    const got = await core.getGlobalMcpServer({ name: 'plugin-demo:docs' });
    expect(got).toMatchObject({ source: 'plugin', url: 'https://example.com/mcp' });
    await expect(core.getGlobalMcpServer({ name: 'missing' })).rejects.toMatchObject({
      code: 'mcp.server_not_found',
    });
  });

  it('waits for the initial plugin load before registry-backed management calls', async () => {
    const pluginRoot = await makePlugin('demo', {
      docs: { transport: 'http', url: 'https://example.com/mcp' },
    });
    const { core } = await makeCore(async (home) => {
      await writeJson(join(home, 'plugins', 'installed.json'), {
        version: 1,
        plugins: [
          {
            id: 'demo',
            root: pluginRoot,
            source: 'local-path',
            enabled: true,
            installedAt: new Date().toISOString(),
          },
        ],
      });
    });

    // Called right after construction, while the constructor-kicked plugin
    // load is still in flight: the management view must wait for it and list
    // the plugin server, and a shadowing user-level write must be rejected.
    const list = await core.listGlobalMcpServers({});
    expect(list.map((entry) => entry.name)).toContain('plugin-demo:docs');
    await expect(
      core.addGlobalMcpServer({
        server: { name: 'plugin-demo:docs', transport: 'http', url: 'https://example.com/v2' },
      }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
  });

  it('surfaces the initial plugin load failure in registry-backed management calls', async () => {
    const { core } = await makeCore(async (home) => {
      await mkdir(join(home, 'plugins'), { recursive: true });
      await writeFile(join(home, 'plugins', 'installed.json'), '{not-json', 'utf8');
    });

    await expect(core.listGlobalMcpServers({})).rejects.toMatchObject({
      code: 'plugin.load_failed',
    });
  });

  it('rejects mutations of read-only entries and keeps store errors for global ones', async () => {
    const { core } = await makeCore();
    const pluginRoot = await makePlugin('demo', {
      docs: { transport: 'http', url: 'https://example.com/mcp' },
    });
    await core.installPlugin({ source: pluginRoot });

    await expect(
      core.updateGlobalMcpServer({
        server: { name: 'plugin-demo:docs', transport: 'http', url: 'https://example.com/v2' },
      }),
    ).rejects.toMatchObject({ code: 'request.invalid', message: expect.stringContaining('plugin') });
    await expect(core.removeGlobalMcpServer({ name: 'plugin-demo:docs' })).rejects.toMatchObject({
      code: 'request.invalid',
    });
    await expect(
      core.addGlobalMcpServer({
        server: { name: 'plugin-demo:docs', transport: 'http', url: 'https://example.com/v2' },
      }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    await expect(
      core.updateGlobalMcpServer({
        server: { name: 'unknown', transport: 'http', url: 'https://example.com/mcp' },
      }),
    ).rejects.toMatchObject({ code: 'mcp.server_not_found' });
  });

  it('tests an inline unsaved config and a plugin server by name', async () => {
    const { core } = await makeCore();
    const inline = await core.testGlobalMcpServer({
      server: {
        name: 'unsaved-probe',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE],
      },
    });
    expect(inline.success).toBe(true);
    expect(inline.output).toContain('Available tools: 3');

    const server = await startMcpHttpServer();
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: server.url },
    });
    await core.installPlugin({ source: pluginRoot });
    const byName = await core.testGlobalMcpServer({ name: 'plugin-demo:api' });
    expect(byName.success).toBe(true);
    expect(byName.output).toContain('echo');

    await expect(core.testGlobalMcpServer({})).rejects.toMatchObject({
      code: 'request.invalid',
    });
  }, 20000);

  it('pushes global add / update / remove into live sessions', async () => {
    const { core, rpc, workDir } = await makeCore();
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;

    await core.addGlobalMcpServer({
      server: {
        name: 'working',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE],
      },
    });
    expect(session.mcp.get('working')).toMatchObject({ status: 'connected', source: 'global' });

    await core.updateGlobalMcpServer({
      server: {
        name: 'working',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE, '--updated'],
      },
    });
    expect(session.mcp.get('working')?.config).toMatchObject({ args: [STDIO_FIXTURE, '--updated'] });
    expect(session.mcp.get('working')?.status).toBe('connected');

    await core.removeGlobalMcpServer({ name: 'working' });
    expect(session.mcp.get('working')).toBeUndefined();
  }, 30000);

  it('reconciles plugin MCP servers in live sessions on install / disable / enable', async () => {
    const { core, rpc, workDir } = await makeCore();
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;

    const server = await startMcpHttpServer();
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: server.url },
    });
    await core.installPlugin({ source: pluginRoot });
    expect(session.mcp.get('plugin-demo:api')).toMatchObject({
      status: 'connected',
      source: 'plugin',
    });

    await core.setPluginEnabled({ id: 'demo', enabled: false });
    expect(session.mcp.get('plugin-demo:api')).toBeUndefined();

    await core.setPluginEnabled({ id: 'demo', enabled: true });
    expect(session.mcp.get('plugin-demo:api')).toMatchObject({
      status: 'connected',
      source: 'plugin',
    });

    // A disabled plugin server can no longer be reconnected into the session.
    await core.setPluginEnabled({ id: 'demo', enabled: false });
    await expect(rpc.reconnectMcpServer({ sessionId: created.id, name: 'plugin-demo:api' })).rejects.toMatchObject({
      code: 'mcp.server_not_found',
    });
  }, 30000);

  it('addSessionMcpServer connects a caller entry, and persists on request', async () => {
    const { core, rpc, home, workDir } = await makeCore();
    const created = await rpc.createSession({ workDir, model: 'default-mock' });

    const caller = await rpc.addSessionMcpServer({
      sessionId: created.id,
      server: {
        name: 'temp',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE],
      },
    });
    expect(caller).toMatchObject({ name: 'temp', status: 'connected', source: 'caller' });
    await expect(core.listGlobalMcpServers({})).resolves.toEqual([]);

    const persisted = await rpc.addSessionMcpServer({
      sessionId: created.id,
      server: {
        name: 'kept',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE],
      },
      persist: true,
    });
    expect(persisted).toMatchObject({ name: 'kept', status: 'connected', source: 'global' });
    await expect(core.getGlobalMcpServer({ name: 'kept' })).resolves.toMatchObject({
      source: 'global',
      mutable: true,
      origin: join(home, 'mcp.json'),
    });
  }, 30000);

  it('reconnects a needs-auth session entry when credentials land', async () => {
    const server = await startMcpHttpServer({ bearerToken: 'good-token' });
    const { core, rpc, home, workDir } = await makeCore();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { gated: { transport: 'http', url: server.url } },
    });
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;
    await session.mcp.waitForInitialLoad();
    expect(session.mcp.get('gated')?.status).toBe('needs-auth');

    // A login completing anywhere in the process (management plane or the
    // synthetic auth tool) must reach the live session by itself.
    await coreOAuth(core).getProvider('gated', server.url).saveTokens({
      access_token: 'good-token',
      token_type: 'Bearer',
    });
    for (let i = 0; i < 100; i++) {
      if (session.mcp.get('gated')?.status === 'connected') break;
      await sleep(50);
    }
    expect(session.mcp.get('gated')?.status).toBe('connected');
  }, 30000);

  it('flips a connected session entry back to needs-auth when credentials are reset', async () => {
    const server = await startMcpHttpServer({ bearerToken: 'good-token' });
    const { core, rpc, home, workDir } = await makeCore();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { gated: { transport: 'http', url: server.url } },
    });
    await coreOAuth(core).getProvider('gated', server.url).saveTokens({
      access_token: 'good-token',
      token_type: 'Bearer',
    });
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;
    await session.mcp.waitForInitialLoad();
    expect(session.mcp.get('gated')?.status).toBe('connected');

    await core.resetGlobalMcpServerAuth({ name: 'gated' });
    for (let i = 0; i < 100; i++) {
      if (session.mcp.get('gated')?.status === 'needs-auth') break;
      await sleep(50);
    }
    expect(session.mcp.get('gated')?.status).toBe('needs-auth');
  }, 30000);

  it('classifies expired stored credentials as oauth-expired', async () => {
    const { core, home } = await makeCore();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        stale: { transport: 'http', url: 'https://stale.example.test/mcp', auth: 'oauth' },
        refreshable: { transport: 'http', url: 'https://refresh.example.test/mcp', auth: 'oauth' },
        fresh: { transport: 'http', url: 'https://fresh.example.test/mcp', auth: 'oauth' },
      },
    });
    const oauth = coreOAuth(core);
    await oauth.getProvider('stale', 'https://stale.example.test/mcp').saveTokens({
      access_token: 'dead',
      token_type: 'Bearer',
      expires_in: -60,
    });
    await oauth.getProvider('refreshable', 'https://refresh.example.test/mcp').saveTokens({
      access_token: 'old',
      refresh_token: 'still-good',
      token_type: 'Bearer',
      expires_in: -60,
    });
    await oauth.getProvider('fresh', 'https://fresh.example.test/mcp').saveTokens({
      access_token: 'good',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const statuses = await core.listGlobalMcpServerAuthStatuses({});
    expect(statuses).toEqual([
      { name: 'stale', authStatus: 'oauth-expired' },
      { name: 'refreshable', authStatus: 'oauth-authorized' },
      { name: 'fresh', authStatus: 'oauth-authorized' },
    ]);
  });

  it('classifies disabled servers as not-applicable, even with online verification', async () => {
    const { core, home } = await makeCore();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        off: {
          transport: 'http',
          url: 'https://disabled.example.test/mcp',
          auth: 'oauth',
          enabled: false,
        },
      },
    });
    await expect(core.listGlobalMcpServerAuthStatuses({ verify: true })).resolves.toEqual([
      { name: 'off', authStatus: 'not-applicable' },
    ]);
  });

  it('inspects global and plugin servers with locators and real connection states', async () => {
    const gated = await startMcpHttpServer({ bearerToken: 'good-token', oauthRejecting: true });
    const plain = await startMcpHttpServer();
    const { core, home } = await makeCore();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        plain: { transport: 'http', url: plain.url },
        stale: { transport: 'http', url: gated.url, auth: 'oauth' },
      },
    });
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: plain.url },
    });
    await core.installPlugin({ source: pluginRoot });
    // A stored grant whose refresh is rejected (invalid_grant) classifies as
    // expired after the probe, distinct from never-logged-in.
    await coreOAuth(core).getProvider('stale', gated.url).saveTokens({
      access_token: 'wrong-token',
      refresh_token: 'dead-refresh-token',
      token_type: 'Bearer',
    });

    const inspections = await core.inspectAppMcpServers({});
    const byId = new Map(inspections.map((server) => [server.serverId, server]));

    expect(byId.get('global:plain')).toMatchObject({
      locator: { source: 'global', name: 'plain' },
      runtimeName: 'plain',
      origin: 'global',
      editable: true,
      enabled: true,
      authStatus: 'not-applicable',
      canonicalUrl: plain.url,
    });
    expect(byId.get('global:stale')).toMatchObject({
      authStatus: 'oauth-expired',
      editable: true,
    });
    expect(byId.get('plugin:demo:api')).toMatchObject({
      locator: { source: 'plugin', pluginId: 'demo', serverName: 'api' },
      runtimeName: 'plugin-demo:api',
      origin: 'plugin',
      editable: false,
      enabled: true,
      authStatus: 'not-applicable',
    });

    // Targets narrow the inspection; unknown locators reject.
    const targeted = await core.inspectAppMcpServers({
      targets: [{ source: 'plugin', pluginId: 'demo', serverName: 'api' }],
    });
    expect(targeted).toHaveLength(1);
    expect(targeted[0]?.serverId).toBe('plugin:demo:api');
    await expect(
      core.inspectAppMcpServers({ targets: [{ source: 'global', name: 'missing' }] }),
    ).rejects.toMatchObject({ code: 'mcp.server_not_found' });
  }, 20000);

  it('marks a runtime-name collision as unavailable instead of probing it', async () => {
    const plain = await startMcpHttpServer();
    const { core, home } = await makeCore();
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: plain.url },
    });
    await core.installPlugin({ source: pluginRoot });
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { 'plugin-demo:api': { transport: 'http', url: plain.url } },
    });

    const targeted = await core.inspectAppMcpServers({
      targets: [{ source: 'plugin', pluginId: 'demo', serverName: 'api' }],
    });
    expect(targeted[0]).toMatchObject({
      runtimeName: 'plugin-demo:api',
      authStatus: 'unavailable',
      error: 'MCP runtime name "plugin-demo:api" is not unique',
    });
    // Both sides of the collision stay visible in the catalog.
    const all = await core.inspectAppMcpServers({});
    expect(all.filter((server) => server.runtimeName === 'plugin-demo:api')).toHaveLength(2);
  }, 20000);

  it('keeps a project-layer shadow when the user-level entry changes', async () => {
    const { core, rpc, home, workDir } = await makeCore();
    // workDir doubles as the repo root: the project-root `.mcp.json` shadows
    // the user-level entry with the same name.
    await writeJson(join(workDir, '.git', 'keep'), {});
    await writeJson(join(workDir, '.mcp.json'), {
      mcpServers: {
        shadowed: { command: process.execPath, args: [STDIO_FIXTURE, '--project'] },
      },
    });
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { shadowed: { command: '/this/path/does/not/exist/anywhere' } },
    });
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;
    await session.mcp.waitForInitialLoad();
    // The effective config comes from the project layer.
    expect(session.mcp.get('shadowed')).toMatchObject({ status: 'connected', source: 'global' });
    expect(session.mcp.get('shadowed')?.config).toMatchObject({
      args: [STDIO_FIXTURE, '--project'],
    });

    // A user-level edit must not clobber the project-layer shadow.
    await core.updateGlobalMcpServer({
      server: {
        name: 'shadowed',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE, '--user'],
      },
    });
    expect(session.mcp.get('shadowed')).toMatchObject({
      status: 'connected',
      config: { args: [STDIO_FIXTURE, '--project'] },
    });

    // Removing the user-level entry keeps the shadow running as well.
    await core.removeGlobalMcpServer({ name: 'shadowed' });
    expect(session.mcp.get('shadowed')?.status).toBe('connected');
  }, 30000);

  it('drives OAuth RPCs by locator, including plugin servers', async () => {
    const { core } = await makeCore();
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: 'https://example.com/mcp', auth: 'oauth' },
    });
    await core.installPlugin({ source: pluginRoot });
    const locator = { source: 'plugin', pluginId: 'demo', serverName: 'api' } as const;

    // Reset is a no-network invalidate and works for plugin servers.
    await expect(core.resetMcpServerAuth({ locator })).resolves.toBeUndefined();
    // The legacy name-based variant resolves through the registry too.
    await expect(
      core.resetGlobalMcpServerAuth({ name: 'plugin-demo:api' }),
    ).resolves.toBeUndefined();
    await expect(
      core.beginMcpServerAuth({ locator: { source: 'global', name: 'missing' } }),
    ).rejects.toMatchObject({ code: 'mcp.server_not_found' });
    await expect(core.cancelMcpServerAuth({ flowId: 'unknown-flow' })).resolves.toBeUndefined();
    await expect(core.completeMcpServerAuth({ flowId: 'unknown-flow' })).rejects.toMatchObject({
      code: 'request.invalid',
    });
  }, 20000);

  it('restores the shadowed file-layer entry when a plugin server is disabled', async () => {
    const http = await startMcpHttpServer();
    const { core, rpc, home, workDir } = await makeCore();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        'plugin-demo:api': { command: process.execPath, args: [STDIO_FIXTURE] },
      },
    });
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: http.url },
    });
    await core.installPlugin({ source: pluginRoot });
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;
    await session.mcp.waitForInitialLoad();
    // The enabled plugin wins the colliding runtime name at session start.
    expect(session.mcp.get('plugin-demo:api')).toMatchObject({
      status: 'connected',
      source: 'plugin',
      transport: 'http',
    });

    // Disabling the plugin falls back to the shadowed user-level entry
    // instead of leaving the session without the server.
    await core.setPluginEnabled({ id: 'demo', enabled: false });
    expect(session.mcp.get('plugin-demo:api')).toMatchObject({
      status: 'connected',
      source: 'global',
      transport: 'stdio',
    });

    // Re-enabling restores the plugin winner.
    await core.setPluginEnabled({ id: 'demo', enabled: true });
    expect(session.mcp.get('plugin-demo:api')).toMatchObject({
      status: 'connected',
      source: 'plugin',
      transport: 'http',
    });
  }, 30000);

  it('removes the live connection when removing a user-level entry shadowed only by a disabled plugin', async () => {
    const { core, rpc, home, workDir } = await makeCore();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        'plugin-demo:api': { command: process.execPath, args: [STDIO_FIXTURE] },
      },
    });
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: 'https://example.com/mcp' },
    });
    await core.installPlugin({ source: pluginRoot });
    await core.setPluginMcpServerEnabled({ id: 'demo', server: 'api', enabled: false });
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;
    await session.mcp.waitForInitialLoad();
    // The disabled plugin entry stays out of the session; the user-level
    // entry runs under the colliding runtime name.
    expect(session.mcp.get('plugin-demo:api')).toMatchObject({
      status: 'connected',
      source: 'global',
    });

    // Removing it must tear the connection down even though the registry
    // still holds the plugin's read-only disabled descriptor.
    await core.removeGlobalMcpServer({ name: 'plugin-demo:api' });
    expect(session.mcp.get('plugin-demo:api')).toBeUndefined();
  }, 30000);

  it('allows a global add over a disabled plugin descriptor', async () => {
    const { core, rpc, workDir } = await makeCore();
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: 'https://example.com/mcp' },
    });
    await core.installPlugin({ source: pluginRoot });
    await core.setPluginMcpServerEnabled({ id: 'demo', server: 'api', enabled: false });

    // The disabled plugin descriptor is absent from the runtime, so the
    // user-level fallback must be installable after the plugin was disabled.
    await core.addGlobalMcpServer({
      server: {
        name: 'plugin-demo:api',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE],
      },
    });
    await expect(
      core.getGlobalMcpServer({ name: 'plugin-demo:api' }),
    ).resolves.toMatchObject({ mutable: true });

    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;
    await session.mcp.waitForInitialLoad();
    expect(session.mcp.get('plugin-demo:api')).toMatchObject({
      status: 'connected',
      source: 'global',
    });
  }, 30000);

  it('falls back to a project-layer shadow that appeared while the session was live', async () => {
    const { core, rpc, home, workDir } = await makeCore();
    await writeJson(join(workDir, '.git', 'keep'), {});
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        shadowed: { command: process.execPath, args: [STDIO_FIXTURE, '--user'] },
      },
    });
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;
    await session.mcp.waitForInitialLoad();
    expect(session.mcp.get('shadowed')).toMatchObject({
      status: 'connected',
      config: { args: [STDIO_FIXTURE, '--user'] },
    });

    // The project layer starts shadowing the name mid-session; removing the
    // user-level entry falls back to it instead of killing the server.
    await writeJson(join(workDir, '.mcp.json'), {
      mcpServers: {
        shadowed: { command: process.execPath, args: [STDIO_FIXTURE, '--project'] },
      },
    });
    await core.removeGlobalMcpServer({ name: 'shadowed' });
    expect(session.mcp.get('shadowed')).toMatchObject({
      status: 'connected',
      source: 'global',
      config: { args: [STDIO_FIXTURE, '--project'] },
    });
  }, 30000);

  it('pushes a persisted session add into the other live sessions', async () => {
    const { core, rpc, workDir } = await makeCore();
    const first = await rpc.createSession({ workDir, model: 'default-mock' });
    const second = await rpc.createSession({ workDir, model: 'default-mock' });
    const secondSession = core.sessions.get(second.id)!;

    await rpc.addSessionMcpServer({
      sessionId: first.id,
      server: {
        name: 'kept',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE],
      },
      persist: true,
    });
    expect(secondSession.mcp.get('kept')).toMatchObject({
      status: 'connected',
      source: 'global',
    });
  }, 30000);

  it('rejects a persisted session add over a project-layer shadow', async () => {
    const { core, rpc, workDir } = await makeCore();
    await writeJson(join(workDir, '.git', 'keep'), {});
    await writeJson(join(workDir, '.mcp.json'), {
      mcpServers: { shadowed: { command: '/this/path/does/not/exist/anywhere' } },
    });
    const created = await rpc.createSession({ workDir, model: 'default-mock' });

    await expect(
      rpc.addSessionMcpServer({
        sessionId: created.id,
        server: {
          name: 'shadowed',
          transport: 'stdio',
          command: process.execPath,
          args: [STDIO_FIXTURE],
        },
        persist: true,
      }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    // Nothing was persisted to the user-level file either.
    await expect(core.getGlobalMcpServer({ name: 'shadowed' })).rejects.toMatchObject({
      code: 'mcp.server_not_found',
    });
  }, 30000);

  it('shadows a plugin entry on a session-local add, but still rejects persisted writes', async () => {
    const http = await startMcpHttpServer();
    const { core, rpc, workDir } = await makeCore();
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: http.url },
    });
    await core.installPlugin({ source: pluginRoot });
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;
    await session.mcp.waitForInitialLoad();
    expect(session.mcp.get('plugin-demo:api')?.source).toBe('plugin');

    // A session-local add is caller injection, which shadows every registry
    // source — plugins included — exactly like session-start injection does.
    const caller = await rpc.addSessionMcpServer({
      sessionId: created.id,
      server: {
        name: 'plugin-demo:api',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE],
      },
    });
    expect(caller).toMatchObject({
      name: 'plugin-demo:api',
      status: 'connected',
      source: 'caller',
    });

    // Persisting the same name is still a user-level write behind a read-only
    // plugin owner (registry guard), so it is rejected and nothing is stored.
    await expect(
      rpc.addSessionMcpServer({
        sessionId: created.id,
        server: {
          name: 'plugin-demo:api',
          transport: 'stdio',
          command: process.execPath,
          args: [STDIO_FIXTURE],
        },
        persist: true,
      }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    // Nothing landed in the mutable user-level file: the only entry for this
    // name remains the plugin's read-only descriptor.
    const listed = await core.listGlobalMcpServers({});
    expect(
      listed
        .filter((entry) => entry.name === 'plugin-demo:api')
        .every((entry) => entry.mutable === false),
    ).toBe(true);
  }, 30000);

  it('normalizes session MCP names so the store, session, and reconcile agree', async () => {
    const { core, rpc, workDir } = await makeCore();
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;

    const added = await rpc.addSessionMcpServer({
      sessionId: created.id,
      server: {
        name: '  spaced  ',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE],
      },
      persist: true,
    });
    expect(added).toMatchObject({ name: 'spaced', status: 'connected' });
    await expect(core.getGlobalMcpServer({ name: 'spaced' })).resolves.toMatchObject({
      name: 'spaced',
    });
    expect(session.mcp.get('spaced')?.status).toBe('connected');
    expect(session.mcp.get('  spaced  ')).toBeUndefined();

    // A blank name is rejected before anything connects, persist or not.
    await expect(
      rpc.addSessionMcpServer({
        sessionId: created.id,
        server: { name: '   ', transport: 'http', url: 'https://example.com/mcp' },
      }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
  }, 30000);

  it('normalizes global mutation names so live sessions follow the stored key', async () => {
    const { core, rpc, workDir } = await makeCore();
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;

    // A padded global add persists trimmed and reconciles the trimmed name:
    // the live session connects the server under its stored identity.
    await core.addGlobalMcpServer({
      server: {
        name: '  padded-global  ',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE],
      },
    });
    await expect(core.getGlobalMcpServer({ name: 'padded-global' })).resolves.toMatchObject({
      name: 'padded-global',
    });
    expect(session.mcp.get('padded-global')?.status).toBe('connected');
    expect(session.mcp.get('  padded-global  ')).toBeUndefined();

    // Padded remove drops the trimmed entry and tears the session entry down.
    await core.removeGlobalMcpServer({ name: ' padded-global ' });
    expect(session.mcp.get('padded-global')).toBeUndefined();

    // A padded name still hits the read-only guard for plugin owners.
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: 'https://example.com/mcp' },
    });
    await core.installPlugin({ source: pluginRoot });
    await expect(
      core.addGlobalMcpServer({
        server: { name: ' plugin-demo:api ', transport: 'http', url: 'https://example.com/mcp' },
      }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
  }, 30000);

  it('keeps caller-injected servers when a plugin collides on the runtime name', async () => {
    const http = await startMcpHttpServer();
    const { core, rpc, workDir } = await makeCore();
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: http.url },
    });
    await core.installPlugin({ source: pluginRoot });
    const created = await rpc.createSession({
      workDir,
      model: 'default-mock',
      mcpServers: {
        'plugin-demo:api': {
          transport: 'stdio',
          command: process.execPath,
          args: [STDIO_FIXTURE],
        },
      },
    });
    const session = core.sessions.get(created.id)!;
    await session.mcp.waitForInitialLoad();
    // Caller injection is per-session explicit intent and wins the collision.
    expect(session.mcp.get('plugin-demo:api')).toMatchObject({
      status: 'connected',
      source: 'caller',
      transport: 'stdio',
    });

    // Plugin state churn must not displace the caller entry either.
    await core.setPluginEnabled({ id: 'demo', enabled: false });
    expect(session.mcp.get('plugin-demo:api')).toMatchObject({
      status: 'connected',
      source: 'caller',
      transport: 'stdio',
    });
  }, 30000);

  it('reconnects a plugin-shadowed name to the plugin winner, not the file layer', async () => {
    const http = await startMcpHttpServer();
    const { core, rpc, home, workDir } = await makeCore();
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        'plugin-demo:api': { command: process.execPath, args: [STDIO_FIXTURE] },
      },
    });
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: http.url },
    });
    await core.installPlugin({ source: pluginRoot });
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;
    await session.mcp.waitForInitialLoad();
    expect(session.mcp.get('plugin-demo:api')).toMatchObject({ source: 'plugin' });

    await rpc.reconnectMcpServer({ sessionId: created.id, name: 'plugin-demo:api' });
    expect(session.mcp.get('plugin-demo:api')).toMatchObject({
      status: 'connected',
      source: 'plugin',
      transport: 'http',
    });
  }, 30000);

  it('redacts secret-bearing config values in session and management views', async () => {
    const { core, rpc, home, workDir } = await makeCore();
    const pluginRoot = await makePlugin('demo', {
      runner: {
        transport: 'stdio',
        // Plugin manifests only accept PATH-style commands.
        command: 'node',
        args: [STDIO_FIXTURE],
        env: { PLUGIN_API_KEY: 'plugin-secret' },
      },
    });
    await core.installPlugin({ source: pluginRoot });
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        own: {
          command: process.execPath,
          args: [STDIO_FIXTURE],
          env: { USER_TOKEN: 'user-secret' },
        },
      },
    });

    // Management view: read-only entries report key names only; mutable
    // user-level entries keep their values so edit UIs can prefill them.
    const managed = new Map((await core.listGlobalMcpServers({})).map((s) => [s.name, s]));
    const pluginEntry = managed.get('plugin-demo:runner');
    expect(pluginEntry).toMatchObject({
      mutable: false,
      envKeys: expect.arrayContaining(['PLUGIN_API_KEY']),
    });
    expect(pluginEntry).not.toHaveProperty('env');
    expect(managed.get('own')).toMatchObject({
      mutable: true,
      env: { USER_TOKEN: 'user-secret' },
    });

    // Session status view: every entry is redacted, regardless of source.
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    await core.sessions.get(created.id)!.mcp.waitForInitialLoad();
    const listed = await rpc.listMcpServers({ sessionId: created.id });
    const own = listed.find((entry) => entry.name === 'own');
    expect(own?.config).toMatchObject({ envKeys: ['USER_TOKEN'] });
    expect(own?.config).not.toHaveProperty('env');
  }, 30000);

  it('rejects legacy name-based auth/reset under a runtime-name collision', async () => {
    const plain = await startMcpHttpServer();
    const { core, home } = await makeCore();
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: plain.url, auth: 'oauth' },
    });
    await core.installPlugin({ source: pluginRoot });
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        'plugin-demo:api': { transport: 'http', url: plain.url, auth: 'oauth' },
      },
    });

    // A name-only call cannot tell which of the two enabled entries owns the
    // OAuth credential, so it must refuse like the locator path does.
    await expect(core.beginGlobalMcpServerAuth({ name: 'plugin-demo:api' })).rejects.toMatchObject({
      code: 'request.invalid',
      message: expect.stringContaining('shared by multiple enabled servers'),
    });
    await expect(core.resetGlobalMcpServerAuth({ name: 'plugin-demo:api' })).rejects.toMatchObject({
      code: 'request.invalid',
      message: expect.stringContaining('shared by multiple enabled servers'),
    });
  }, 20000);

  it('resolves legacy name-based auth to the sole enabled entry under a disabled shadow', async () => {
    const { core, home } = await makeCore();
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: 'https://example.com/mcp', auth: 'oauth' },
    });
    await core.installPlugin({ source: pluginRoot });
    // The disabled file-layer entry lists first in registry order, but the
    // enabled plugin is the only runtime target: a name-only auth action must
    // act on it, not reject on a disabled "conflict".
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        'plugin-demo:api': {
          transport: 'http',
          url: 'https://example.com/other',
          auth: 'oauth',
          enabled: false,
        },
      },
    });

    // Reset is a no-network credential invalidate, so it deterministically
    // proves the legacy resolver completed without an ambiguity rejection.
    await expect(
      core.resetGlobalMcpServerAuth({ name: 'plugin-demo:api' }),
    ).resolves.toBeUndefined();
  }, 20000);

  it('surfaces registry config errors during sync instead of tearing down live servers', async () => {
    const { core, rpc, home, workDir } = await makeCore();
    await writeJson(join(workDir, '.git', 'keep'), {});
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { working: { command: process.execPath, args: [STDIO_FIXTURE] } },
    });
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    const session = core.sessions.get(created.id)!;
    await session.mcp.waitForInitialLoad();
    expect(session.mcp.get('working')).toMatchObject({ status: 'connected', source: 'global' });

    // The project config file becomes malformed mid-session: a config-aware
    // reconnect must surface the config error, not "no longer configured"…
    await writeFile(join(workDir, '.mcp.json'), '{not json', 'utf8');
    await expect(
      rpc.reconnectMcpServer({ sessionId: created.id, name: 'working' }),
    ).rejects.toMatchObject({ code: 'config.invalid' });

    // …and a global sync keeps the live entry running (the failure is
    // logged; an unreadable file is not a license to tear connections down).
    await core.updateGlobalMcpServer({
      server: {
        name: 'working',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE, '--updated'],
      },
    });
    expect(session.mcp.get('working')).toMatchObject({
      status: 'connected',
      config: { args: [STDIO_FIXTURE] },
    });

    // Fixing the file lets the next sync converge again.
    await writeJson(join(workDir, '.mcp.json'), { mcpServers: {} });
    await core.updateGlobalMcpServer({
      server: {
        name: 'working',
        transport: 'stdio',
        command: process.execPath,
        args: [STDIO_FIXTURE, '--healed'],
      },
    });
    expect(session.mcp.get('working')).toMatchObject({
      status: 'connected',
      config: { args: [STDIO_FIXTURE, '--healed'] },
    });
  }, 30000);

  it('rejects a persisted session add when the project config is unreadable', async () => {
    const { core, rpc, workDir } = await makeCore();
    await writeJson(join(workDir, '.git', 'keep'), {});
    const created = await rpc.createSession({ workDir, model: 'default-mock' });
    // The project config breaks while the session is live.
    await writeFile(join(workDir, '.mcp.json'), '{not json', 'utf8');

    await expect(
      rpc.addSessionMcpServer({
        sessionId: created.id,
        server: {
          name: 'kept',
          transport: 'stdio',
          command: process.execPath,
          args: [STDIO_FIXTURE],
        },
        persist: true,
      }),
    ).rejects.toMatchObject({ code: 'config.invalid' });
    // The unreadable state must not be papered over with a user-level write.
    await expect(core.getGlobalMcpServer({ name: 'kept' })).rejects.toMatchObject({
      code: 'mcp.server_not_found',
    });
  }, 30000);

  it('rejects a name-only connection test under a runtime-name collision', async () => {
    const plain = await startMcpHttpServer();
    const { core, home } = await makeCore();
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: plain.url },
    });
    await core.installPlugin({ source: pluginRoot });
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: { 'plugin-demo:api': { transport: 'http', url: plain.url } },
    });

    await expect(core.testGlobalMcpServer({ name: 'plugin-demo:api' })).rejects.toMatchObject({
      code: 'request.invalid',
      message: expect.stringContaining('shared by multiple enabled servers'),
    });
  }, 20000);

  it('tests the enabled entry when the name collides with a disabled shadow', async () => {
    const plain = await startMcpHttpServer();
    const { core, home } = await makeCore();
    const pluginRoot = await makePlugin('demo', {
      api: { transport: 'http', url: plain.url },
    });
    await core.installPlugin({ source: pluginRoot });
    // The disabled file entry lists before the plugin in registry order, but
    // the enabled plugin is what a live session would actually run.
    await writeJson(join(home, 'mcp.json'), {
      mcpServers: {
        'plugin-demo:api': {
          transport: 'http',
          url: 'http://127.0.0.1:1/unreachable',
          enabled: false,
        },
      },
    });

    const result = await core.testGlobalMcpServer({ name: 'plugin-demo:api' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('echo');
  }, 20000);
});
