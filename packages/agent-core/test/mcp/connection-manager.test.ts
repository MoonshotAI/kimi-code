import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { testKaos } from '../fixtures/test-kaos';
import type { ProviderConfig } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';

import { KimiError } from '../../src/errors';
import { ProviderManager } from '../../src/session/provider-manager';
import { McpConnectionManager, type McpServerEntry } from '../../src/mcp/connection-manager';
import { JsonFileStore, McpOAuthService } from '../../src/mcp/oauth';
import type { AgentEvent, SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { SessionAPIImpl } from '../../src/session/rpc';
import { createScriptedGenerate } from '../agent/harness';


const here = import.meta.dirname;
const stdioFixture = join(here, 'fixtures', 'mock-stdio-server.mjs');
const slowStdioFixture = join(here, 'fixtures', 'slow-stdio-server.mjs');
const crashAfterConnectFixture = join(here, 'fixtures', 'crash-after-connect-stdio-server.mjs');
const stderrThenExitFixture = join(here, 'fixtures', 'stderr-then-exit-stdio-server.mjs');
const MOCK_PROVIDER: ProviderConfig = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
};
type SessionRpcEvent = AgentEvent & { readonly agentId: string };

function stdioConfig(args: string[] = [stdioFixture]) {
  return {
    transport: 'stdio' as const,
    command: process.execPath,
    args,
  };
}

function sessionRpc(options: {
  readonly events?: SessionRpcEvent[] | undefined;
  readonly onEvent?: ((event: SessionRpcEvent) => void) | undefined;
} = {}): SDKSessionRPC {
  return {
    emitEvent: async (event: SessionRpcEvent) => {
      options.events?.push(event);
      options.onEvent?.(event);
    },
    requestApproval: async () => ({ decision: 'rejected' }),
    requestQuestion: async () => null,
    toolCall: async () => ({ output: '' }),
  } as unknown as SDKSessionRPC;
}

describe('McpConnectionManager', () => {
  it('connects servers in parallel and exposes connected entries with their tool count', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({ alpha: stdioConfig(), beta: stdioConfig() });
      const entries = cm.list();
      expect(entries.map((e) => e.name).toSorted()).toEqual(['alpha', 'beta']);
      for (const entry of entries) {
        expect(entry.status).toBe('connected');
        expect(entry.toolCount).toBe(3);
        expect(entry.transport).toBe('stdio');
      }
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('isolates failures: a bad server is marked failed without blocking the rest', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({
        good: stdioConfig(),
        bad: { transport: 'stdio', command: '/this/path/does/not/exist/anywhere' },
      });
      const good = cm.get('good');
      const bad = cm.get('bad');
      expect(good?.status).toBe('connected');
      expect(bad?.status).toBe('failed');
      expect(bad?.error).toBeDefined();
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('marks HTTP servers failed when configured bearer token env var is missing', async () => {
    const cm = new McpConnectionManager({ envLookup: () => undefined });
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: 'https://example.invalid/mcp',
          bearerTokenEnvVar: 'REMOTE_MCP_TOKEN',
        },
      });
      const entry = cm.get('remote');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('"REMOTE_MCP_TOKEN" is not set or is empty');
    } finally {
      await cm.shutdown();
    }
  });

  it('marks SSE servers failed when configured bearer token env var is missing', async () => {
    const cm = new McpConnectionManager({ envLookup: () => undefined });
    try {
      await cm.connectAll({
        legacy: {
          transport: 'sse',
          url: 'https://example.invalid/sse',
          bearerTokenEnvVar: 'LEGACY_MCP_TOKEN',
        },
      });
      const entry = cm.get('legacy');
      expect(entry?.transport).toBe('sse');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('"LEGACY_MCP_TOKEN" is not set or is empty');
    } finally {
      await cm.shutdown();
    }
  });

  it('marks disabled servers without attempting a connection', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({
        off: { ...stdioConfig(), enabled: false },
      });
      const entry = cm.get('off');
      expect(entry?.status).toBe('disabled');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
    }
  });

  it('applies enabledTools / disabledTools filters to the resolved tool set', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({
        filtered: { ...stdioConfig(), enabledTools: ['echo'], disabledTools: ['boom'] },
      });
      const resolved = cm.resolved('filtered');
      expect(resolved).toBeDefined();
      expect([...(resolved?.enabledNames ?? [])]).toEqual(['echo']);
      const entry = cm.get('filtered');
      expect(entry?.toolCount).toBe(1);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('emits status transitions in order (pending → connected) per server', async () => {
    const cm = new McpConnectionManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      const statuses = seen.filter((s) => s.name === 'alpha').map((s) => s.status);
      expect(statuses).toEqual(['pending', 'connected']);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('reconnect cycles a failed server back through pending and into connected when fixed', async () => {
    const cm = new McpConnectionManager();
    try {
      // First, set up with bad config to land in `failed`.
      await cm.connectAll({
        flaky: { transport: 'stdio', command: '/no/such/binary' },
      });
      expect(cm.get('flaky')?.status).toBe('failed');

      // Patch the entry's internal config to point at the real fixture by
      // re-registering through the manager. There is no public `update`
      // method; reconnect uses the original config stored at connectAll
      // time, so we re-run connectAll with the corrected entry.
      await cm.shutdown();

      await cm.connectAll({ flaky: stdioConfig() });
      await cm.reconnect('flaky');
      expect(cm.get('flaky')?.status).toBe('connected');
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('does not let stale in-flight startup failures overwrite a reconnect attempt', async () => {
    const cm = new McpConnectionManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });
    const delayedMockServer = `setTimeout(() => import(${JSON.stringify(pathToFileURL(stdioFixture).href)}), 250)`;

    const connect = cm.connectAll({
      slow: {
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', delayedMockServer],
        startupTimeoutMs: 2_000,
      },
    });

    try {
      await sleep(50);
      await cm.reconnect('slow');
      await connect;

      expect(cm.get('slow')).toMatchObject({
        status: 'connected',
        toolCount: 3,
      });
      expect(seen.filter((event) => event.name === 'slow').map((event) => event.status)).toEqual([
        'pending',
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
      await Promise.race([connect.catch(() => {}), sleep(1_000)]);
    }
  }, 7000);

  it('reconnect throws a coded KimiError when the server name is unknown', async () => {
    const cm = new McpConnectionManager();
    try {
      await expect(cm.reconnect('nope')).rejects.toBeInstanceOf(KimiError);
      await expect(cm.reconnect('nope')).rejects.toMatchObject({ code: 'mcp.server_not_found' });
    } finally {
      await cm.shutdown();
    }
  });

  it('reconnect rejects disabled servers without connecting them', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({
        off: { ...stdioConfig(), enabled: false },
      });

      const reconnect = cm.reconnect('off');
      await expect(reconnect).rejects.toBeInstanceOf(KimiError);
      await expect(reconnect).rejects.toMatchObject({ code: 'mcp.server_disabled' });
      expect(cm.get('off')).toMatchObject({
        status: 'disabled',
        toolCount: 0,
      });
    } finally {
      await cm.shutdown();
    }
  });

  it('shutdown clears entries and is idempotent', async () => {
    const cm = new McpConnectionManager();
    await cm.connectAll({ alpha: stdioConfig() });
    expect(cm.list().length).toBe(1);
    await cm.shutdown();
    expect(cm.list().length).toBe(0);
    // Second call must not throw.
    await cm.shutdown();
  }, 15000);

  it('shutdown cancels in-flight startup without late status updates', async () => {
    const cm = new McpConnectionManager();
    const hangingListFixture = join(here, 'fixtures', 'hanging-list-stdio-server.mjs');
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });

    const connectPromise = cm.connectAll({
      slowList: {
        transport: 'stdio',
        command: process.execPath,
        args: [hangingListFixture],
        startupTimeoutMs: 5_000,
      },
    });

    await sleep(50);
    await cm.shutdown();

    const result = await Promise.race([
      connectPromise.then(() => 'resolved' as const),
      sleep(1_000).then(() => 'hung' as const),
    ]);
    expect(result).toBe('resolved');
    expect(cm.list()).toEqual([]);
    expect(seen).toEqual([{ name: 'slowList', status: 'pending' }]);
  }, 2000);

  it('honors startupTimeoutMs by marking slow servers failed', async () => {
    const cm = new McpConnectionManager();
    try {
      // The stub.mjs fixture below sleeps before doing the handshake, so a
      // very small startupTimeoutMs should fire before connect() returns.
      const slowFixture = join(here, 'fixtures', 'slow-stdio-server.mjs');
      await cm.connectAll({
        slow: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowFixture],
          startupTimeoutMs: 100,
        },
      });
      const entry = cm.get('slow');
      expect(entry?.status).toBe('failed');
      expect(entry?.error?.toLowerCase()).toContain('timed out');
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('honors startupTimeoutMs while discovering tools', async () => {
    const cm = new McpConnectionManager();
    const hangingListFixture = join(here, 'fixtures', 'hanging-list-stdio-server.mjs');
    const connectPromise = cm.connectAll({
      slowList: {
        transport: 'stdio',
        command: process.execPath,
        args: [hangingListFixture],
        startupTimeoutMs: 100,
      },
    });
    try {
      const result = await Promise.race([
        connectPromise.then(() => 'resolved' as const),
        sleep(1_000).then(() => 'hung' as const),
      ]);
      expect(result).toBe('resolved');

      const entry = cm.get('slowList');
      expect(entry?.status).toBe('failed');
      expect(entry?.error?.toLowerCase()).toContain('timed out');
    } finally {
      await cm.shutdown();
      await Promise.race([connectPromise.catch(() => {}), sleep(1_000)]);
    }
  }, 7000);

  it('flips HTTP servers into needs-auth when the server returns 401 and no static token is set', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const storeDir = await mkdtemp(join(tmpdir(), 'kimi-mcp-oauth-cm-'));
    const oauthService = new McpOAuthService({ store: new JsonFileStore(storeDir) });
    const cm = new McpConnectionManager({ oauthService });
    try {
      await cm.connectAll({
        gated: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('gated');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login gated');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 15000);

  it('flips SSE servers into needs-auth when the server returns 401 and no static token is set', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'text/plain',
        'www-authenticate': 'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end('unauthorized');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const storeDir = await mkdtemp(join(tmpdir(), 'kimi-mcp-oauth-sse-cm-'));
    const oauthService = new McpOAuthService({ store: new JsonFileStore(storeDir) });
    const cm = new McpConnectionManager({ oauthService });
    try {
      await cm.connectAll({
        legacy: {
          transport: 'sse',
          url: `http://127.0.0.1:${port}/sse`,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('legacy');
      expect(entry?.transport).toBe('sse');
      expect(entry?.status).toBe('needs-auth');
      expect(entry?.error).toContain('run /mcp-config login legacy');
      expect(entry?.toolCount).toBe(0);
    } finally {
      await cm.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 15000);

  it('flips cached OAuth credentials that require reauth into needs-auth', async () => {
    const server: HttpServer = createHttpServer((req, res) => {
      if (req.url === '/token') {
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const serverUrl = `http://127.0.0.1:${port}/mcp`;
    const authServerUrl = `http://127.0.0.1:${port}`;
    const storeDir = await mkdtemp(join(tmpdir(), 'kimi-mcp-oauth-cached-'));
    const oauthService = new McpOAuthService({ store: new JsonFileStore(storeDir) });
    const provider = oauthService.getProvider('notion', serverUrl);
    provider.saveDiscoveryState({
      authorizationServerUrl: authServerUrl,
      authorizationServerMetadata: {
        issuer: authServerUrl,
        authorization_endpoint: `${authServerUrl}/authorize`,
        token_endpoint: `${authServerUrl}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });
    provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    provider.saveTokens({
      access_token: 'stale-access-token',
      refresh_token: 'stale-refresh-token',
      token_type: 'Bearer',
    } satisfies OAuthTokens);

    const cm = new McpConnectionManager({ oauthService });
    try {
      await cm.connectAll({
        notion: {
          transport: 'http',
          url: serverUrl,
          startupTimeoutMs: 5_000,
        },
      });
      const entry = cm.get('notion');
      expect(entry).toMatchObject({
        status: 'needs-auth',
        error: expect.stringContaining('run /mcp-config login notion'),
      });
      expect(entry?.error).not.toContain('redirectUrl must be set');
    } finally {
      await cm.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 15000);

  it('marks HTTP 401 as failed (not needs-auth) when no OAuth service is configured', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401).end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({
        gated: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('gated')?.status).toBe('failed');
    } finally {
      await cm.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  }, 15000);

  it('flips connected stdio servers to failed when the child exits unexpectedly', async () => {
    const cm = new McpConnectionManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        crashy: {
          transport: 'stdio',
          command: process.execPath,
          args: [crashAfterConnectFixture],
          env: { KIMI_TEST_MCP_EXIT_AFTER_MS: '500', KIMI_TEST_MCP_STDERR: 'fatal: out of memory' },
          startupTimeoutMs: 4_000,
        },
      });
      expect(cm.get('crashy')?.status).toBe('connected');

      // Wait for the child to die and the manager to notice via onclose.
      for (let i = 0; i < 100; i++) {
        if (cm.get('crashy')?.status === 'failed') break;
        await sleep(50);
      }
      const entry = cm.get('crashy');
      expect(entry?.status).toBe('failed');
      expect(entry?.toolCount).toBe(0);
      expect(entry?.error).toBeDefined();
      expect(entry?.error?.toLowerCase()).toContain('closed');
      // stderr tail should appear in the error so users can debug.
      expect(entry?.error).toContain('fatal: out of memory');
      // Status events should include the new failed transition.
      const statuses = seen.filter((s) => s.name === 'crashy').map((s) => s.status);
      expect(statuses).toEqual(['pending', 'connected', 'failed']);
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('includes captured stderr in the error when stdio connect fails before handshake', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({
        nope: {
          transport: 'stdio',
          command: process.execPath,
          args: [stderrThenExitFixture],
          env: { KIMI_TEST_MCP_STDERR: 'fatal: missing API token KIMI_X' },
          startupTimeoutMs: 4_000,
        },
      });
      const entry = cm.get('nope');
      expect(entry?.status).toBe('failed');
      expect(entry?.error).toContain('fatal: missing API token KIMI_X');
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('does not flip to failed when the manager intentionally closes the client', async () => {
    const cm = new McpConnectionManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(cm.get('alpha')?.status).toBe('connected');
      await cm.shutdown();
      // Give any stray onclose handlers a chance to fire.
      await sleep(100);
      // After shutdown the entry is gone; no extra `failed` event must be
      // emitted from the intentional close path.
      const statuses = seen.filter((s) => s.name === 'alpha').map((s) => s.status);
      expect(statuses).toEqual(['pending', 'connected']);
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('flips connected HTTP servers to failed when the SDK reports a terminal transport error', async () => {
    // Use the SDK's own in-process HTTP server so the connect succeeds; once
    // the entry is `connected`, simulate the SDK calling Client.onerror with
    // the reconnect-exhausted message (the path streamable-http uses to
    // report a dead transport — there is no `onclose` for that case).
    const mcpServer = new McpServer({ name: 'cm-terminal', version: '0.0.1' });
    mcpServer.registerTool(
      'echo',
      { description: 'Echoes text', inputSchema: { text: z.string() } },
      ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await mcpServer.connect(transport);
    const httpServer = createHttpServer((req, res) => {
      void transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as HttpAddress).port;

    const cm = new McpConnectionManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({
        remote: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('remote')?.status).toBe('connected');

      // Reach into the live client to invoke the same hook the SDK uses.
      const internalClient = (cm as unknown as {
        entries: Map<string, { client?: { client: { onerror?: (e: Error) => void } } }>;
      }).entries.get('remote')?.client?.client;
      internalClient?.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));

      // Listener fires asynchronously through our wrapper; allow microtasks.
      for (let i = 0; i < 50; i++) {
        if (cm.get('remote')?.status === 'failed') break;
        await sleep(25);
      }
      const entry = cm.get('remote');
      expect(entry?.status).toBe('failed');
      expect(entry?.toolCount).toBe(0);
      expect(entry?.error).toContain('Maximum reconnection attempts');
      const statuses = seen.filter((s) => s.name === 'remote').map((s) => s.status);
      expect(statuses).toEqual(['pending', 'connected', 'failed']);
    } finally {
      await cm.shutdown();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  }, 15000);

  it('marks HTTP 401 as failed (not needs-auth) when the user pinned static headers', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401).end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const storeDir = await mkdtemp(join(tmpdir(), 'kimi-mcp-oauth-cm-'));
    const oauthService = new McpOAuthService({ store: new JsonFileStore(storeDir) });
    const cm = new McpConnectionManager({ oauthService });
    try {
      await cm.connectAll({
        keyed: {
          transport: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { 'X-API-Key': 'wrong' },
          startupTimeoutMs: 5_000,
        },
      });
      expect(cm.get('keyed')?.status).toBe('failed');
    } finally {
      await cm.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 15000);
});

describe('Session MCP startup', () => {
  it('stores default MCP OAuth credentials under the configured Kimi home', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kimi-session-mcp-oauth-home-'));
    const processHome = join(tmp, 'process-home');
    const kimiHome = join(tmp, 'kimi-home');
    const oldHome = process.env['HOME'];
    process.env['HOME'] = processHome;

    const session = new Session({
      id: 'test-mcp-oauth',
      kaos: testKaos.withCwd(tmp),
      homedir: join(tmp, 'session'),
      kimiHomeDir: kimiHome,
      rpc: sessionRpc(),
    });

    try {
      const oauthService = session.mcp.oauthService;
      if (oauthService === undefined) {
        throw new Error('Expected session MCP manager to own an OAuth service');
      }
      const provider = oauthService.getProvider('gated', 'https://example.com/mcp');
      provider.saveTokens({
        access_token: 'session-token',
        token_type: 'Bearer',
      } satisfies OAuthTokens);

      await expect(
        readFile(
          join(kimiHome, 'credentials', 'mcp', `${provider.storeKey}-tokens.json`),
          'utf-8',
        ),
      ).resolves.toContain('session-token');
      await expect(
        readFile(
          join(processHome, '.kimi-code', 'credentials', 'mcp', `${provider.storeKey}-tokens.json`),
          'utf-8',
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await session.close();
      if (oldHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = oldHome;
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('does not block main agent creation on slow MCP startup', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kimi-session-mcp-startup-'));
    const session = new Session({
      id: 'test-mcp-slow',
      kaos: testKaos.withCwd(tmp),
      homedir: join(tmp, 'session'),
      rpc: sessionRpc(),
      mcpConfig: {
        servers: {
          slow: {
            transport: 'stdio',
            command: process.execPath,
            args: [slowStdioFixture],
            startupTimeoutMs: 2_000,
          },
        },
      },
    });

    const create = session.createMain();
    try {
      const result = await Promise.race([
        create.then(() => 'resolved' as const),
        sleep(1_000).then(() => 'blocked' as const),
      ]);
      expect(result).toBe('resolved');
    } finally {
      await session.close();
      await Promise.race([create.catch(() => {}), sleep(1_000)]);
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  }, 7000);

  it('waits for initial MCP startup before the first prompt reaches the model', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kimi-session-mcp-prompt-'));
    const events: SessionRpcEvent[] = [];
    let resolveTurnEnded!: () => void;
    const turnEnded = new Promise<void>((resolve) => {
      resolveTurnEnded = resolve;
    });
    const scripted = createScriptedGenerate();
    scripted.mockNextResponse({ type: 'text', text: 'ready' });
    const session = new Session({
      id: 'test-mcp-turn-ended',
      kaos: testKaos.withCwd(tmp),
      homedir: join(tmp, 'session'),
      rpc: sessionRpc({
        events,
        onEvent: (event) => {
          if (event.type === 'turn.ended') resolveTurnEnded();
        },
      }),
      providerManager: testProviderManager(),
      mcpConfig: {
        servers: {
          slow: {
            transport: 'stdio',
            command: process.execPath,
            args: [stdioFixture],
            env: { KIMI_TEST_MCP_START_DELAY_MS: '250' },
            startupTimeoutMs: 2_000,
          },
        },
      },
    });

    try {
      const { agent } = await session.createAgent({
        type: 'main',
        generate: scripted.generate,
      });
      agent.config.update({
        cwd: tmp,
        modelAlias: 'mock-model',
        systemPrompt: 'test system prompt',
        thinkingLevel: 'off',
      });
      // This bare agent gets no profile, so grant MCP access explicitly.
      agent.tools.setActiveTools(['mcp__*']);

      await new SessionAPIImpl(session).prompt({
        agentId: 'main',
        input: [{ type: 'text', text: 'hello' }],
      });
      await sleep(100);

      expect(events.some((event) => event.type === 'turn.started')).toBe(true);
      expect(events.some((event) => event.type === 'turn.step.started')).toBe(false);
      expect(scripted.calls).toHaveLength(0);

      await Promise.race([
        turnEnded,
        sleep(1_000).then(() => {
          throw new Error('Timed out waiting for turn.ended');
        }),
      ]);

      expect(scripted.calls).toHaveLength(1);
      const toolNames = scripted.calls[0]!.tools.map((tool) => tool.name);
      expect(toolNames).toContain('mcp__slow__echo');
    } finally {
      await session.close();
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  }, 7000);

  it('emits tool.list.updated(mcp.disconnected) when reconnect drops the live tools', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kimi-session-mcp-reconnect-'));
    const events: SessionRpcEvent[] = [];
    const session = new Session({
      id: 'test-mcp-mixed',
      kaos: testKaos.withCwd(tmp),
      homedir: join(tmp, 'session'),
      rpc: sessionRpc({ events }),
      mcpConfig: {
        servers: {
          good: {
            transport: 'stdio',
            command: process.execPath,
            args: [stdioFixture],
            startupTimeoutMs: 4_000,
          },
        },
      },
    });

    try {
      await session.createMain();
      // Wait until the initial connect has registered tools.
      for (let i = 0; i < 50; i++) {
        const connected = events.some(
          (e) => e.type === 'tool.list.updated' && e.reason === 'mcp.connected',
        );
        if (connected) break;
        await sleep(50);
      }
      const initialConnected = events.filter(
        (e) => e.type === 'tool.list.updated' && e.reason === 'mcp.connected',
      ).length;
      expect(initialConnected).toBeGreaterThanOrEqual(1);

      events.length = 0;
      await session.mcp.reconnect('good');
      // The reconnect cycle: pending (tools cleared) → connected (tools back).
      // Both transitions must surface as tool.list.updated so SDK consumers
      // watching that event don't see stale tools mid-cycle.
      const disconnects = events.filter(
        (e) => e.type === 'tool.list.updated' && e.reason === 'mcp.disconnected',
      );
      const connects = events.filter(
        (e) => e.type === 'tool.list.updated' && e.reason === 'mcp.connected',
      );
      expect(disconnects.length).toBeGreaterThanOrEqual(1);
      expect(connects.length).toBeGreaterThanOrEqual(1);
    } finally {
      await session.close();
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  }, 10_000);
});

function testProviderManager(): ProviderManager {
  return new ProviderManager({
    config: {
      providers: {
        test: {
          type: MOCK_PROVIDER.type,
          apiKey: MOCK_PROVIDER.apiKey,
        },
      },
      models: {
        [MOCK_PROVIDER.model]: {
          provider: 'test',
          model: MOCK_PROVIDER.model,
          maxContextSize: 1_000_000,
        },
      },
    },
  });
}
