import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Tool as KosongTool } from '#/kosong/contract/tool';
import { z } from 'zod';

import type { McpOAuthStore } from '#/agent/mcp/oauth/store';
import type { MCPClient, MCPToolDefinition } from '#/agent/mcp/types';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

export const fixturesDir = new URL('./fixtures/', import.meta.url).pathname;
export const stdioFixture = new URL('./fixtures/mock-stdio-server.mjs', import.meta.url).pathname;
export const cwdStdioFixture = new URL('./fixtures/cwd-stdio-server.mjs', import.meta.url).pathname;
export const slowStdioFixture = new URL('./fixtures/slow-stdio-server.mjs', import.meta.url).pathname;
export const hangingListStdioFixture = new URL(
  './fixtures/hanging-list-stdio-server.mjs',
  import.meta.url,
).pathname;
export const crashAfterConnectFixture = new URL(
  './fixtures/crash-after-connect-stdio-server.mjs',
  import.meta.url,
).pathname;
export const stderrThenExitFixture = new URL(
  './fixtures/stderr-then-exit-stdio-server.mjs',
  import.meta.url,
).pathname;

export function createMemoryMcpOAuthStore(): McpOAuthStore {
  const data = new Map<string, unknown>();
  return {
    async read<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async write(key: string, value: unknown): Promise<void> {
      data.set(key, structuredClone(value));
    },
    async remove(key: string): Promise<void> {
      data.delete(key);
    },
  };
}

export function fakeMcpClient(
  tools: readonly MCPToolDefinition[] = [
    {
      name: 'echo',
      description: 'Echoes back',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'noop',
      description: 'Does nothing',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
): MCPClient {
  return {
    async listTools() {
      return [...tools];
    },
    async callTool(name, args) {
      if (name === 'echo') {
        return { content: [{ type: 'text', text: String(args['text']) }], isError: false };
      }
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    },
  };
}

export async function discoverTools(client: MCPClient): Promise<KosongTool[]> {
  const defs = await client.listTools();
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.inputSchema as Record<string, unknown>,
  }));
}

export type TestExecutableToolContext<Input> = ExecutableToolContext & {
  readonly args: Input;
};

export async function executeTool<Input>(
  tool: ExecutableTool<Input>,
  context: TestExecutableToolContext<Input>,
): Promise<ExecutableToolResult> {
  const { args, ...executionContext } = context;
  const resolved = tool.resolveExecution(args);
  const execution: ToolExecution = isPromiseLike(resolved) ? await resolved : resolved;
  if (execution.isError === true) return execution;
  return execution.execute(executionContext);
}

export async function startInProcessHttpMcpServer(opts?: {
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

  await listen(httpServer);
  const port = (httpServer.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => closeServer(httpServer),
  };
}

export async function startInProcessSseMcpServer(opts?: {
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

  await listen(httpServer);
  const port = (httpServer.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      await Promise.all([...transports.values()].map((transport) => transport.close()));
      await closeServer(httpServer);
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}
