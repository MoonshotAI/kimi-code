import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SseMcpClient, isTerminalSseTransportError } from '../../src/mcp/client-sse';

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
