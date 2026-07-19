import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createSecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Tool as KosongTool } from '#/app/llmProtocol/tool';
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

const H2_STALL_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUDoSXEvr8xtqEm9NGkEfpabMw8CUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcxOTA3NTQyOVoXDTM2MDcx
NjA3NTQyOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEApdJUKNqaXWXo9dEEwEky2BNqbzzv20scyB/Tp1KaQvGn
n9L9ZVlEUM3HLRu1GcOp7OS6lu97PC3SZypHbUOQrw+iN540hef0jpXGUquxW2/R
NTbdaG7XHyBTOBOtPipRT83ikYPtBh0nBgD/s41y5LSyetMsQ9T5IkJ3IIGUxim1
heNifKujm0belDADGJ48iwqQv6d14nHHePIZESZ73E1QLw4D0TNQG0ei+gj3OnLz
DzgizEUzw8UVEsjOkdpbUc/JRpN5Fsn1qG3lRu37Ob4lbs0ymEZSmbj6h0Nx9TSF
9ldRg5vq5eq/X+duMh9rXambe4BRmYPSiNXlFjD2MQIDAQABo28wbTAdBgNVHQ4E
FgQUoC+OxUv9E65b/9G8bU/+w6DE1dQwHwYDVR0jBBgwFoAUoC+OxUv9E65b/9G8
bU/+w6DE1dQwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAGy3Obij9yhEYTi7wo7x2SqSrIiHJFhl
NKXmGE8UqXitWsOWZ3cwHEPdofRYwXLmtkGuWYG1QLuuQN36wD/6jgAUGcuR2Ezk
ZKe5Xq6/kxCst+RXzWGIe5ktz349/Jc+u52p73y4dJxAImdEjLm30HI7k6oKAN/2
Vb8qBFwCWImPICiUhMW+e9O9f4mFI/A5BbNeeI4zrpZoSDb9FhLPmkdE2T/PNcTQ
bClPGKoWApLJGNFEpPVX9/N+vwxAOAxiKqVq13gCrXgWHCeVwdfaRG8xzuBJ0Ysg
CgFL/dPQMJBQhBYBpsFuz7M4z9Q5zUFRPxkzxs4JgSdZ/YZ7cI0g2+0=
-----END CERTIFICATE-----`;

const H2_STALL_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCl0lQo2ppdZej1
0QTASTLYE2pvPO/bSxzIH9OnUppC8aef0v1lWURQzcctG7UZw6ns5LqW73s8LdJn
KkdtQ5CvD6I3njSF5/SOlcZSq7Fbb9E1Nt1obtcfIFM4E60+KlFPzeKRg+0GHScG
AP+zjXLktLJ60yxD1PkiQncggZTGKbWF42J8q6ObRt6UMAMYnjyLCpC/p3Xiccd4
8hkRJnvcTVAvDgPRM1AbR6L6CPc6cvMPOCLMRTPDxRUSyM6R2ltRz8lGk3kWyfWo
beVG7fs5viVuzTKYRlKZuPqHQ3H1NIX2V1GDm+rl6r9f524yH2tdqZt7gFGZg9KI
1eUWMPYxAgMBAAECggEAB1MgYRKbnX242eeS+7xwA2/uHxOfGRMlu72o1NwMUOHe
+0DFF92RgTaUcldmO0kI6pwwQCZmzZciPhOLHADkn/sDOcziTzpFCP8Fh5V/zC/H
BcBSl5WdKTSSwH12r7I2V8ha1lMwcePxRe20MytPydmlMFGU2Q/hYQ70Yf+fVwEi
mzIuSZpPoqUfETeCtqQ1/ZDb3fe9Y11bLnTGymOEXcjJajCHUNomscK9rTwo6+NI
gxZpi/koZpR0QzRbBpEQs/alw3pR8HY1jk+rQS0u70vFm5YbrduKerD7QMbJbtnY
9TfTWg8sSwyrImLS4makPQMIjeiW6nI8RVhVQ3vovQKBgQDVWa0owcyN+/sRMRIU
njfNMZAk2+DdfyGldFuYntb19rlJ0aQYzH+/qNGSpZCwXffyI6ZqemNMOgDxPwGv
nBPDNpKSWRrDEJvNDMOadP832UwyfIgxLQwvL7HUX6Nccz0iS0a7ONE8FKV6PIPn
lO1HF215ZLNiwUJ+AFsHjLLuHQKBgQDG+FgFtSEi0SunVP2WNe6OJKlVJDmcw241
xPNrt4wCYXxd4lKurqV4W4TjjJnd3/Z4JNAS8S/yzoqXvwA4NOKgAPG0ORv/o9jG
7U+snbwGBMLIiMCfh2cAgBKintsoz23aHZZRXtdbNWCyZan+/ih0HSZDRUA32UBc
QZ91crD8JQKBgEEzEpPuBdEuPF/Ymynp4Cu5Bc/90g5el620jXlqsU6hg6Znhrp9
ZFzx/nnOVxVO4kMBWg4YMNhOsZMIKj+8dt2lg81tpZwPK03SpMRDFOvAYGTdYdGF
br/M14+LWqUaIoikcI0uo+K0fI2KiNTw0kJzimUavSdk4CkZergn61aRAoGBAJSO
sAny5z67tkBFsOEKe4cd0GCFn45wTEVRO/5dGOheKSFf7iQGuf1XN60+OVPz+G5T
7hd2hTphBBGwxlUxB1Q34D+TtFf22dANN8PGMbC8tUJM+KUjz8AL394Thca+uWJ1
XNp8WYb8H6qTRY3h7gpkCUGI3x3T074OMSTb8VERAoGAeqgZdLE2Y3nvmlHWZlb0
fdiiaKKBNHICLYSNa4uW0a5rWSVw+cWgJYFvmFkz5DuTJkAOyLukNouC3TYUWcTe
al9H7C0WYMmTbMeDrJa0/UgHBkuxkCua2W8Z69x0g14vR4ni21DaGXomNQXS9R8k
pN9iHuSv+UDZLidheNnLqOY=
-----END PRIVATE KEY-----`;

/**
 * Mimics the wire behavior of Cloudflare-hosted MCP servers that broke
 * remote MCP startup: over a single HTTP/2 connection, `initialize` is
 * answered and the standalone GET SSE stream is held open, but a POST
 * (e.g. `tools/list`) sent while that GET stream is open is never answered.
 * HTTP/1.1 requests are always answered.
 */
export async function startStallingH2McpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const initializeResult = (id: unknown) =>
    `event: message\ndata: ${JSON.stringify({
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'h2-stall-mock', version: '0.0.1' },
      },
      jsonrpc: '2.0',
      id,
    })}\n\n`;
  const toolsResult = (id: unknown) =>
    `event: message\ndata: ${JSON.stringify({
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echoes text',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
      },
      jsonrpc: '2.0',
      id,
    })}\n\n`;

  const server = createSecureServer({
    allowHTTP1: true,
    cert: H2_STALL_TEST_CERT,
    key: H2_STALL_TEST_KEY,
  });

  // HTTP/2 requests arrive on the 'stream' event.
  server.on('stream', (stream, headers) => {
    const method = headers[':method'];
    if (method === 'GET') {
      // Standalone SSE stream: respond and hold it open, never writing.
      stream.respond({ ':status': 200, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      return;
    }
    let body = '';
    stream.on('data', (chunk: Buffer) => (body += chunk.toString()));
    stream.on('end', () => {
      const message = JSON.parse(body) as { method?: string; id?: unknown };
      if (message.method === 'initialize') {
        stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
        stream.end(initializeResult(message.id));
        return;
      }
      if (message.method === 'notifications/initialized') {
        stream.respond({ ':status': 202 });
        stream.end();
        return;
      }
      // The stall: over H2, post-handshake POSTs (tools/list, tools/call)
      // are never answered. The real-world trigger is the standalone GET
      // stream being open on the same connection; because the SDK opens it
      // asynchronously, keying on the stream directly would make this mimic
      // racy, so it stalls all post-handshake H2 POSTs deterministically.
      return;
    });
  });

  // HTTP/1.1 requests also arrive on the compat 'request' event (H2 requests
  // fire both 'stream' and 'request'; only handle 1.x here). Always answered.
  server.on('request', (req, res) => {
    if (req.httpVersionMajor !== 1 || res.headersSent) return;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      // Hold the stream open; an empty write flushes headers without a body chunk.
      res.write('');
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const message = JSON.parse(body) as { method?: string; id?: unknown };
      if (message.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(message.method === 'initialize' ? initializeResult(message.id) : toolsResult(message.id));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `https://localhost:${port}/mcp`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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
