import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ErrorCodes, KimiError } from '../../src/errors';
import {
  buildMcpHttpHeaders,
  HttpMcpClient,
  isTerminalTransportError,
} from '../../src/mcp/client-http';

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
    expect(error).toBeInstanceOf(KimiError);
    expect((error as KimiError).code).toBe(ErrorCodes.CONFIG_INVALID);
    return;
  }
  throw new Error('expected function to throw');
}

describe('buildMcpHttpHeaders', () => {
  it('returns undefined when no headers and no bearer are configured', () => {
    expect(
      buildMcpHttpHeaders({ transport: 'http', url: 'https://x' }, () => undefined),
    ).toBeUndefined();
  });

  it('passes through configured static headers', () => {
    expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', headers: { 'X-Tenant': 'kimi' } },
        () => undefined,
      ),
    ).toEqual({ 'X-Tenant': 'kimi' });
  });

  it('injects Authorization Bearer when env lookup yields a token', () => {
    expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', bearerTokenEnvVar: 'TOK' },
        (name) => (name === 'TOK' ? 'secret' : undefined),
      ),
    ).toEqual({ Authorization: 'Bearer secret' });
  });

  it('throws KimiError(config.invalid) when a configured bearer token env var is empty or missing', () => {
    expectConfigInvalid(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', bearerTokenEnvVar: 'MISSING' },
        () => undefined,
      ),
    );
    expect(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', bearerTokenEnvVar: 'MISSING' },
        () => undefined,
      ),
    ).toThrow(/"MISSING" is not set or is empty/);
    expectConfigInvalid(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', bearerTokenEnvVar: 'EMPTY' },
        () => '',
      ),
    );
    expect(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', bearerTokenEnvVar: 'EMPTY' },
        () => '',
      ),
    ).toThrow(/"EMPTY" is not set or is empty/);
  });

  it('merges bearer over the same Authorization key from static headers', () => {
    expect(
      buildMcpHttpHeaders(
        {
          transport: 'http',
          url: 'https://x',
          headers: { Authorization: 'Bearer stale', 'X-Trace': '1' },
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

  it('strips case-variant authorization headers before injecting the bearer', () => {
    expect(
      buildMcpHttpHeaders(
        {
          transport: 'http',
          url: 'https://x',
          headers: { authorization: 'Bearer stale', AUTHORIZATION: 'Bearer older', 'X-Trace': '1' },
          bearerTokenEnvVar: 'TOK',
        },
        () => 'fresh',
      ),
    ).toEqual({ Authorization: 'Bearer fresh', 'X-Trace': '1' });
  });

  it('returns undefined when headers is an empty object and no bearer token', () => {
    expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', headers: {} },
        () => undefined,
      ),
    ).toBeUndefined();
  });

  it('handles a URL with special characters in the path', () => {
    expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://example.com/mcp/server?version=1&locale=zh-CN' },
        () => undefined,
      ),
    ).toBeUndefined();
  });
});

describe('isTerminalTransportError', () => {
  it('classifies SDK terminal errors correctly', () => {
    expect(isTerminalTransportError(new Error('Maximum reconnection attempts (3) exceeded.'))).toBe(true);

    const unauthorized = new Error('Unauthorized');
    unauthorized.name = 'UnauthorizedError';
    expect(isTerminalTransportError(unauthorized)).toBe(true);
  });

  it('does not flag generic errors as terminal', () => {
    expect(isTerminalTransportError(new Error('Generic error'))).toBe(false);
    expect(isTerminalTransportError(new Error(''))).toBe(false);
  });

  it('does not flag errors with unrelated names as terminal', () => {
    const err = new Error('Not authorized');
    err.name = 'SyntaxError';
    expect(isTerminalTransportError(err)).toBe(false);
  });
});

async function startInProcessHttpMcpServer(opts?: {
  authToken?: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const mcpServer = new McpServer({ name: 'mock-http', version: '0.0.1' });
  mcpServer.registerTool(
    'echo',
    { description: 'Echoes text', inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: 'text', text }] }),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(transport);

  const httpServer: Server = createServer((req, res) => {
    if (opts?.authToken !== undefined) {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${opts.authToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }
    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, 'localhost', resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;

  return {
    url: `http://localhost:${port}/mcp`,
    async close() {
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
      // The SDK normally calls `Client.onerror` from its own retry loop
      // (e.g. "Maximum reconnection attempts (3) exceeded.") — there is no
      // matching `onclose` for HTTP. Simulate that path directly to exercise
      // the terminal-error branch without rigging an SSE reconnect storm.
      const internal = (client as unknown as {
        client: { onerror?: (error: Error) => void };
      }).client;
      internal.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));
      // Listener may fire in a later microtask; give it a chance.
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
      // SSE flap that the SDK will retry on its own — should NOT flip the
      // entry to failed; otherwise a brief network blip would tear down every
      // HTTP MCP connection.
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

  it('close() is a no-op when connect was never called', async () => {
    const client = new HttpMcpClient({ transport: 'http', url: 'https://example.invalid/mcp' });
    // Must not throw.
    await client.close();
  });

  it('onUnexpectedClose does not throw when no listener is registered', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    try {
      await client.connect();
      // No listener registered — the terminal error must be silently buffered.
      const internal = (client as unknown as {
        client: { onerror?: (error: Error) => void };
      }).client;
      internal.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));
      await new Promise((r) => setTimeout(r, 25));
    } finally {
      await client.close();
    }
  }, 15000);

  it('callTool with empty args still round-trips', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    try {
      await client.connect();
      const result = await client.callTool('echo', {});
      expect(result.isError).toBe(false);
      // The server echoes the text, which is undefined for empty args.
      expect(result.content).toEqual([{ type: 'text', text: 'undefined' }]);
    } finally {
      await client.close();
    }
  }, 15000);
});
