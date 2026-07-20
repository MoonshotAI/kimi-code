import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes, Error2 } from '#/errors';
import { buildMcpHttpHeaders, HttpMcpClient, isTerminalTransportError } from '#/agent/mcp/client-http';

import { startInProcessHttpMcpServer } from './stubs';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function expectConfigInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error2);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    return;
  }
  throw new Error('expected function to throw');
}

describe('buildMcpHttpHeaders', () => {
  it('returns undefined when no headers and no bearer are configured', () => {
    expect(
      buildMcpHttpHeaders({ transport: 'http', url: 'https://x.example.com' }, () => undefined),
    ).toBeUndefined();
  });

  it('passes through configured static headers', () => {
    expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', headers: { 'X-Tenant': 'kimi' } },
        () => undefined,
      ),
    ).toEqual({ 'X-Tenant': 'kimi' });
  });

  it('injects Authorization Bearer when env lookup yields a token', () => {
    expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', bearerTokenEnvVar: 'TOK' },
        (name) => (name === 'TOK' ? 'secret' : undefined),
      ),
    ).toEqual({ Authorization: 'Bearer secret' });
  });

  it('throws Error2(config.invalid) when a configured bearer token env var is empty or missing', () => {
    expectConfigInvalid(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', bearerTokenEnvVar: 'MISSING' },
        () => undefined,
      ),
    );
    expect(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', bearerTokenEnvVar: 'MISSING' },
        () => undefined,
      ),
    ).toThrow(/"MISSING" is not set or is empty/);
    expectConfigInvalid(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x.example.com', bearerTokenEnvVar: 'EMPTY' },
        () => '',
      ),
    );
  });

  it('merges bearer over the same Authorization key from static headers', () => {
    expect(
      buildMcpHttpHeaders(
        {
          transport: 'http',
          url: 'https://x.example.com',
          headers: { Authorization: 'Bearer stale', 'X-Trace': '1' },
          bearerTokenEnvVar: 'TOK',
        },
        () => 'fresh',
      ),
    ).toEqual({ Authorization: 'Bearer fresh', 'X-Trace': '1' });
  });

  it('strips case-variant authorization headers before injecting the bearer', () => {
    expect(
      buildMcpHttpHeaders(
        {
          transport: 'http',
          url: 'https://x.example.com',
          headers: { authorization: 'Bearer stale', AUTHORIZATION: 'Bearer older', 'X-Trace': '1' },
          bearerTokenEnvVar: 'TOK',
        },
        () => 'fresh',
      ),
    ).toEqual({ Authorization: 'Bearer fresh', 'X-Trace': '1' });
  });

  it('flags errors the SDK uses to signal a dead HTTP transport as terminal', () => {
    const unauthorized = new Error('Unauthorized');
    unauthorized.name = 'UnauthorizedError';
    expect(isTerminalTransportError(unauthorized)).toBe(true);
    expect(isTerminalTransportError(new Error('Maximum reconnection attempts (3) exceeded.'))).toBe(
      true,
    );
  });

  it('does not flag transient SDK errors as terminal', () => {
    expect(isTerminalTransportError(new Error('SSE stream disconnected: ECONNRESET'))).toBe(false);
    expect(isTerminalTransportError(new Error('fetch failed'))).toBe(false);
    expect(isTerminalTransportError(new Error('Connection closed'))).toBe(false);
  });
});

describe('HttpMcpClient', () => {
  it('connects, lists tools, and round-trips a call over real HTTP', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);

      const result = await client.callTool('echo', { text: 'hello http' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello http' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('flips to unexpected-close when the SDK signals a terminal transport error', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    const closes: Array<{ error?: string }> = [];
    client.onUnexpectedClose((reason) => {
      closes.push({ error: reason.error?.message });
    });
    try {
      await client.connect();
      const internal = (client as unknown as {
        client: { onerror?: (error: Error) => void };
      }).client;
      internal.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));
      await new Promise((r) => setTimeout(r, 25));
      expect(closes).toHaveLength(1);
      expect(closes[0]?.error).toContain('Maximum reconnection attempts');
    } finally {
      await client.close();
    }
  }, 15000);

  it('ignores transient SDK errors that the transport recovers from', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    const closes: number[] = [];
    client.onUnexpectedClose(() => closes.push(Date.now()));
    try {
      await client.connect();
      const internal = (client as unknown as {
        client: { onerror?: (error: Error) => void };
      }).client;
      internal.onerror?.(new Error('SSE stream disconnected: ECONNRESET'));
      internal.onerror?.(new Error('fetch failed'));
      await new Promise((r) => setTimeout(r, 25));
      expect(closes).toEqual([]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards bearer token from envLookup', async () => {
    const server = await startInProcessHttpMcpServer({ authToken: 'good-token' });
    cleanups.push(server.close);

    const client = new HttpMcpClient(
      {
        transport: 'http',
        url: server.url,
        bearerTokenEnvVar: 'EXAMPLE_TOKEN',
      },
      { envLookup: (name) => (name === 'EXAMPLE_TOKEN' ? 'good-token' : undefined) },
    );
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);
    } finally {
      await client.close();
    }
  }, 15000);
});
