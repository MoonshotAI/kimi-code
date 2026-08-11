import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SseMcpClient, isTerminalSseTransportError } from '../../src/mcp/client-sse';
import { McpOAuthService } from '../../src/mcp/oauth/service';
import { JsonFileStore } from '../../src/mcp/oauth/store';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function startInProcessSseMcpServer(opts?: {
  authToken?: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const transports = new Map<string, SSEServerTransport>();
  const httpServer: Server = createServer((req, res) => {
    if (opts?.authToken !== undefined) {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${opts.authToken}`) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/mcp') {
      const mcpServer = new McpServer({ name: 'mock-sse', version: '0.0.1' });
      mcpServer.registerTool(
        'echo',
        { description: 'Echoes text', inputSchema: { text: z.string() } },
        ({ text }) => ({ content: [{ type: 'text', text }] }),
      );
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };
      void mcpServer.connect(transport);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      const transport = sessionId === null ? undefined : transports.get(sessionId);
      if (transport === undefined) {
        res.writeHead(404).end('Session not found');
        return;
      }
      void transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404).end('not found');
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      await Promise.all([...transports.values()].map((transport) => transport.close()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}

describe('SseMcpClient', () => {
  it('connects, lists tools, and round-trips a call over real SSE', async () => {
    const server = await startInProcessSseMcpServer();
    cleanups.push(server.close);

    const client = new SseMcpClient({ transport: 'sse', url: server.url });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);

      const result = await client.callTool('echo', { text: 'hello sse' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello sse' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards bearer token from envLookup on the SSE and POST requests', async () => {
    const server = await startInProcessSseMcpServer({ authToken: 'good-token' });
    cleanups.push(server.close);

    const client = new SseMcpClient(
      {
        transport: 'sse',
        url: server.url,
        bearerTokenEnvVar: 'EXAMPLE_TOKEN',
      },
      { envLookup: (name) => (name === 'EXAMPLE_TOKEN' ? 'good-token' : undefined) },
    );
    try {
      await client.connect();
      const result = await client.callTool('echo', { text: 'with auth' });
      expect(result.content).toEqual([{ type: 'text', text: 'with auth' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('restores resource 401 after provider auth wraps the startup error', async () => {
    const server = await startInProcessSseMcpServer({ authToken: 'fresh-token' });
    cleanups.push(server.close);
    const storeDir = await mkdtemp(join(tmpdir(), 'kimi-sse-client-oauth-'));
    cleanups.push(() => rm(storeDir, { recursive: true, force: true }));
    const oauth = new McpOAuthService({ store: new JsonFileStore(storeDir) });
    const provider = oauth.getProvider('stale-sse', server.url);
    provider.saveTokens({ access_token: 'stale-token', token_type: 'Bearer' });
    const client = new SseMcpClient(
      { transport: 'sse', url: server.url },
      { oauthProvider: provider },
    );
    try {
      await expect(client.connect()).rejects.toMatchObject({
        name: 'UnauthorizedError',
        cause: expect.any(Error),
      });
    } finally {
      await client.close();
    }
  });

  it('clears a startup 401 before an OAuth retry that rejects without a response', async () => {
    const resourceUrl = 'https://mcp.example.test/sse';
    const authorizationServerUrl = 'https://auth.example.test';
    const tokenUrl = `${authorizationServerUrl}/token`;
    const retryError = new TypeError('fetch failed');
    let resourceRequests = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url =
        typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
      if (url === resourceUrl) {
        resourceRequests += 1;
        if (resourceRequests === 1) return new Response('Unauthorized', { status: 401 });
        throw retryError;
      }
      if (url === tokenUrl) {
        return Response.json({ access_token: 'fresh-token', token_type: 'Bearer' });
      }
      return new Response('Not found', { status: 404 });
    };
    const storeDir = await mkdtemp(join(tmpdir(), 'kimi-sse-client-oauth-retry-'));
    cleanups.push(() => rm(storeDir, { recursive: true, force: true }));
    const provider = new McpOAuthService({ store: new JsonFileStore(storeDir) }).getProvider(
      'retry-sse',
      resourceUrl,
    );
    provider.saveClientInformation({ client_id: 'sse-client-test' });
    provider.saveTokens({
      access_token: 'stale-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
    });
    provider.saveDiscoveryState({
      authorizationServerUrl,
      authorizationServerMetadata: {
        issuer: authorizationServerUrl,
        authorization_endpoint: `${authorizationServerUrl}/authorize`,
        token_endpoint: tokenUrl,
        response_types_supported: ['code'],
      },
    });
    const client = new SseMcpClient(
      { transport: 'sse', url: resourceUrl },
      { fetch: fetchImpl, oauthProvider: provider },
    );
    try {
      const error = await client.connect().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(resourceRequests).toBe(2);
      expect(error).toBeInstanceOf(SseError);
      expect(error).not.toMatchObject({ name: 'UnauthorizedError' });
    } finally {
      await client.close();
    }
  });

  it('does not reclassify a non-401 SSE startup response as unauthorized', async () => {
    const server = await startInProcessSseMcpServer();
    cleanups.push(server.close);
    const client = new SseMcpClient({
      transport: 'sse',
      url: new URL('/missing', server.url).href,
    });
    try {
      const connected = client.connect();
      await expect(connected).rejects.toBeInstanceOf(SseError);
      await expect(connected).rejects.toMatchObject({ code: 404 });
    } finally {
      await client.close();
    }
  });

  it('classifies terminal SSE transport errors without treating reconnect flaps as terminal', () => {
    const unauthorized = new Error('Unauthorized');
    unauthorized.name = 'UnauthorizedError';
    expect(isTerminalSseTransportError(unauthorized)).toBe(true);
    expect(
      isTerminalSseTransportError(
        new SseError(
          204,
          'Server sent HTTP 204',
          {} as ConstructorParameters<typeof SseError>[2],
        ),
      ),
    ).toBe(true);
    expect(isTerminalSseTransportError(new Error('fetch failed'))).toBe(false);
  });
});
