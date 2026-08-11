import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SseMcpClient, isTerminalSseTransportError } from '#/mcpCore/client-sse';
import { McpOAuthService } from '#/mcpCore/oauth/service';

import { createMemoryMcpOAuthStore, startInProcessSseMcpServer } from './stubs';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

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
    const oauth = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const provider = oauth.getProvider('stale-sse', server.url);
    await provider.saveTokens({ access_token: 'stale-token', token_type: 'Bearer' });
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

  it('clears a startup 401 when the OAuth retry returns a non-401 response', async () => {
    const resourceUrl = 'https://mcp.example.test/sse';
    const authorizationServerUrl = 'https://auth.example.test';
    const tokenUrl = `${authorizationServerUrl}/token`;
    let resourceRequests = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url =
        typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
      if (url === resourceUrl) {
        const status = ++resourceRequests === 1 ? 401 : 500;
        return new Response(status === 401 ? 'Unauthorized' : 'Unavailable', { status });
      }
      if (url === tokenUrl) {
        return Response.json({ access_token: 'fresh-token', token_type: 'Bearer' });
      }
      return new Response('Not found', { status: 404 });
    };
    const provider = new McpOAuthService({
      store: createMemoryMcpOAuthStore(),
    }).getProvider('retry-sse', resourceUrl);
    await provider.ready;
    await provider.saveClientInformation({ client_id: 'sse-client-test' });
    await provider.saveTokens({
      access_token: 'stale-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
    });
    await provider.saveDiscoveryState({
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
      expect(error).toMatchObject({ code: 500 });
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
