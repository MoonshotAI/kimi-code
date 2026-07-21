import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'pathe';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { Error2 } from '#/errors';
import { McpConnectionManager, type McpServerEntry } from '#/agent/mcp/connection-manager';
import { McpOAuthService } from '#/agent/mcp/oauth/service';

import {
  closeServer,
  crashAfterConnectFixture,
  createMemoryMcpOAuthStore,
  cwdStdioFixture,
  hangingListStdioFixture,
  slowStdioFixture,
  stderrThenExitFixture,
  stdioFixture,
} from './stubs';

function stdioConfig(args: string[] = [stdioFixture]) {
  return {
    transport: 'stdio' as const,
    command: process.execPath,
    args,
  };
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
      expect(cm.get('good')?.status).toBe('connected');
      expect(cm.get('bad')?.status).toBe('failed');
      expect(cm.get('bad')?.error).toBeDefined();
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
      expect([...(resolved?.enabledNames ?? [])]).toEqual(['echo']);
      expect(cm.get('filtered')?.toolCount).toBe(1);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('starts stdio servers in stdioCwd when config.cwd is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-manager-cwd-'));
    const cm = new McpConnectionManager({ stdioCwd: cwd });
    try {
      await cm.connectAll({
        cwd: stdioConfig([cwdStdioFixture]),
      });
      const resolved = cm.resolved('cwd');
      if (resolved === undefined) throw new Error('Expected cwd MCP server to connect');
      const result = await resolved.client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(cwd));
    } finally {
      await cm.shutdown();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15000);

  it('emits status transitions in order per server', async () => {
    const cm = new McpConnectionManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((e) => seen.push({ name: e.name, status: e.status }));
    try {
      await cm.connectAll({ alpha: stdioConfig() });
      expect(seen.filter((s) => s.name === 'alpha').map((s) => s.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 15000);

  it('reconnect cycles a failed server back through pending and into connected when fixed', async () => {
    const cm = new McpConnectionManager();
    try {
      await cm.connectAll({
        flaky: { transport: 'stdio', command: '/no/such/binary' },
      });
      expect(cm.get('flaky')?.status).toBe('failed');

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
    const delayedMockServer = `setTimeout(() => import(${JSON.stringify(
      pathToFileURL(stdioFixture).href,
    )}), 250)`;

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

  it('reconnect throws a coded Error2 when the server name is unknown', async () => {
    const cm = new McpConnectionManager();
    try {
      await expect(cm.reconnect('nope')).rejects.toBeInstanceOf(Error2);
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

      await expect(cm.reconnect('off')).rejects.toBeInstanceOf(Error2);
      await expect(cm.reconnect('off')).rejects.toMatchObject({ code: 'mcp.server_disabled' });
      expect(cm.get('off')).toMatchObject({
        status: 'disabled',
        toolCount: 0,
      });
    } finally {
      await cm.shutdown();
    }
  });

  it('reconnectAndJoin joins an in-flight reconnect instead of starting a second one', async () => {
    const cm = new McpConnectionManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });
    const delayedMockServer = `setTimeout(() => import(${JSON.stringify(
      pathToFileURL(stdioFixture).href,
    )}), 250)`;

    try {
      await cm.connectAll({
        slow: {
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', delayedMockServer],
          startupTimeoutMs: 5_000,
        },
      });
      seen.length = 0;

      await Promise.all([cm.reconnectAndJoin('slow'), cm.reconnectAndJoin('slow')]);

      expect(cm.get('slow')?.status).toBe('connected');
      expect(seen.filter((event) => event.name === 'slow').map((event) => event.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 20000);

  it('reconnectAndJoin rejects for unknown servers', async () => {
    const cm = new McpConnectionManager();
    try {
      await expect(cm.reconnectAndJoin('nope')).rejects.toBeInstanceOf(Error2);
      await expect(cm.reconnectAndJoin('nope')).rejects.toMatchObject({
        code: 'mcp.server_not_found',
      });
    } finally {
      await cm.shutdown();
    }
  });

  it('shutdown clears entries and is idempotent', async () => {
    const cm = new McpConnectionManager();
    await cm.connectAll({ alpha: stdioConfig() });
    expect(cm.list()).toHaveLength(1);
    await cm.shutdown();
    expect(cm.list()).toEqual([]);
    await cm.shutdown();
  }, 15000);

  it('shutdown cancels in-flight startup without late status updates', async () => {
    const cm = new McpConnectionManager();
    const seen: Array<{ name: string; status: McpServerEntry['status'] }> = [];
    cm.onStatusChange((entry) => {
      seen.push({ name: entry.name, status: entry.status });
    });

    const connectPromise = cm.connectAll({
      slowList: {
        transport: 'stdio',
        command: process.execPath,
        args: [hangingListStdioFixture],
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
      await cm.connectAll({
        slow: {
          transport: 'stdio',
          command: process.execPath,
          args: [slowStdioFixture],
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
    const connectPromise = cm.connectAll({
      slowList: {
        transport: 'stdio',
        command: process.execPath,
        args: [hangingListStdioFixture],
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
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
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
      await closeServer(server);
    }
  }, 15000);

  it('flips SSE servers into needs-auth when the server returns 401 and no static token is set', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401, {
        'content-type': 'text/plain',
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"',
      });
      res.end('unauthorized');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
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
      await closeServer(server);
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
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const provider = oauthService.getProvider('notion', serverUrl);
    await provider.saveDiscoveryState({
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
    await provider.saveClientInformation({
      client_id: 'cached-client',
      redirect_uris: ['http://127.0.0.1:45678/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } satisfies OAuthClientInformationFull);
    await provider.saveTokens({
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
      await closeServer(server);
    }
  }, 15000);

  it('marks HTTP 401 as failed when no OAuth service is configured', async () => {
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
      await closeServer(server);
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

      for (let i = 0; i < 100; i++) {
        if (cm.get('crashy')?.status === 'failed') break;
        await sleep(50);
      }
      const entry = cm.get('crashy');
      expect(entry?.status).toBe('failed');
      expect(entry?.toolCount).toBe(0);
      expect(entry?.error?.toLowerCase()).toContain('closed');
      expect(entry?.error).toContain('fatal: out of memory');
      expect(seen.filter((s) => s.name === 'crashy').map((s) => s.status)).toEqual([
        'pending',
        'connected',
        'failed',
      ]);
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
      await sleep(100);
      expect(seen.filter((s) => s.name === 'alpha').map((s) => s.status)).toEqual([
        'pending',
        'connected',
      ]);
    } finally {
      await cm.shutdown();
    }
  }, 10000);

  it('flips connected HTTP servers to failed when the SDK reports a terminal transport error', async () => {
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

      const internalClient = (cm as unknown as {
        entries: Map<string, { client?: { client: { onerror?: (e: Error) => void } } }>;
      }).entries.get('remote')?.client?.client;
      internalClient?.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));

      for (let i = 0; i < 50; i++) {
        if (cm.get('remote')?.status === 'failed') break;
        await sleep(25);
      }
      const entry = cm.get('remote');
      expect(entry?.status).toBe('failed');
      expect(entry?.toolCount).toBe(0);
      expect(entry?.error).toContain('Maximum reconnection attempts');
      expect(seen.filter((s) => s.name === 'remote').map((s) => s.status)).toEqual([
        'pending',
        'connected',
        'failed',
      ]);
    } finally {
      await cm.shutdown();
      await closeServer(httpServer);
    }
  }, 15000);

  it('marks HTTP 401 as failed when the user pinned static headers', async () => {
    const server: HttpServer = createHttpServer((_req, res) => {
      res.writeHead(401).end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as HttpAddress).port;
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
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
      await closeServer(server);
    }
  }, 15000);
});
