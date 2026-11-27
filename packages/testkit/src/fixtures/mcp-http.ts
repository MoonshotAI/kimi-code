import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { serveFakeMcpCatalog, type FakeMcpCatalog, type FakeMcpTool } from '#/fixtures/mcp-catalog';

export interface FakeMcpHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly rpcMethods: readonly string[];
}

export interface FakeMcpHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly text?: string;
}

export interface FakeMcpHttpServerOptions extends FakeMcpCatalog {
  readonly name?: string;
  readonly transport?: 'streamable-http' | 'sse';
  readonly bearerToken?: string;
  readonly intercept?: (request: FakeMcpHttpRequest) => FakeMcpHttpResponse | undefined | Promise<FakeMcpHttpResponse | undefined>;
}

export interface FakeMcpHttpServer {
  readonly url: string;
  readonly origin: string;
  readonly requests: readonly FakeMcpHttpRequest[];
  readonly answered: readonly FakeMcpHttpRequest[];
  addTool(tool: FakeMcpTool): void;
  updateTool(name: string, change: Partial<Omit<FakeMcpTool, 'name'>>): void;
  removeTool(name: string): void;
  disconnect(): Promise<void>;
  close(): Promise<void>;
}

interface Session {
  readonly mcp: McpServer;
  readonly transport: Transport;
  handle(incoming: IncomingMessage, response: ServerResponse, body: unknown): Promise<void>;
}

const MCP_PATH = '/mcp';
const SSE_MESSAGES_PATH = '/messages';

export async function startFakeMcpHttpServer(options: FakeMcpHttpServerOptions): Promise<FakeMcpHttpServer> {
  const name = options.name ?? 'fake-mcp';
  let tools = [...options.tools];
  const requests: FakeMcpHttpRequest[] = [];
  const answered: FakeMcpHttpRequest[] = [];
  const sessions = new Map<string, Session>();
  const route = options.transport === 'sse' ? routeSse : routeStreamableHttp;

  const sessionServer = (): McpServer => {
    const mcp = new McpServer({ name, version: '0.0.0' });
    serveFakeMcpCatalog(mcp, { name, catalog: options, tools: () => tools });
    return mcp;
  };

  const http = createServer((incoming, response) => {
    void readRequest(incoming).then(async (request) => {
      requests.push(request);
      response.once('finish', () => answered.push(request));
      const answer = (await options.intercept?.(request)) ?? unauthorized(request, options.bearerToken);
      if (answer !== undefined) {
        send(response, answer);
        return;
      }
      await route(incoming, response, request);
    }).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  async function routeStreamableHttp(incoming: IncomingMessage, response: ServerResponse, request: FakeMcpHttpRequest): Promise<void> {
    const parsed = parseJson(request.body);
    const header = incoming.headers['mcp-session-id'];
    const existing = typeof header === 'string' ? sessions.get(header) : undefined;
    if (existing !== undefined) {
      await existing.handle(incoming, response, parsed);
      return;
    }
    if (typeof header === 'string') {
      send(response, { status: 404, json: rpcError(-32001, 'Session not found') });
      return;
    }
    if (parsed === undefined && request.method === 'POST') {
      send(response, { status: 400, json: rpcError(-32700, 'Parse error') });
      return;
    }
    if (!request.rpcMethods.includes('initialize')) {
      send(response, { status: 400, json: rpcError(-32000, 'Bad Request: Mcp-Session-Id header is required') });
      return;
    }
    const mcp = sessionServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { mcp, transport, handle: (...args) => transport.handleRequest(...args) });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
    };
    await mcp.connect(transport);
    await transport.handleRequest(incoming, response, parsed);
  }

  async function routeSse(incoming: IncomingMessage, response: ServerResponse, request: FakeMcpHttpRequest): Promise<void> {
    if (request.method === 'GET' && request.path === MCP_PATH) {
      const mcp = sessionServer();
      // oxlint-disable-next-line typescript/no-deprecated -- the product still connects to SSE MCP servers, so the fake has to serve the transport the SDK deprecates
      const transport = new SSEServerTransport(SSE_MESSAGES_PATH, response);
      transport.onclose = () => sessions.delete(transport.sessionId);
      sessions.set(transport.sessionId, { mcp, transport, handle: (...args) => transport.handlePostMessage(...args) });
      await mcp.connect(transport);
      return;
    }
    if (request.method === 'POST' && request.path === SSE_MESSAGES_PATH) {
      const sessionId = new URL(incoming.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId');
      const session = sessionId === null ? undefined : sessions.get(sessionId);
      if (session === undefined) {
        send(response, { status: 404, text: 'Session not found' });
        return;
      }
      await session.handle(incoming, response, parseJson(request.body));
      return;
    }
    send(response, { status: 404, text: 'not found' });
  }

  const changeTools = (next: FakeMcpTool[]): void => {
    tools = next;
    for (const session of sessions.values()) void session.mcp.server.sendToolListChanged();
  };

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}`;

  return {
    url: `${origin}${MCP_PATH}`,
    origin,
    requests,
    answered,
    addTool: (tool) => changeTools([...tools, tool]),
    updateTool: (toolName, change) => changeTools(tools.map((tool) => (tool.name === toolName ? { ...tool, ...change } : tool))),
    removeTool: (toolName) => changeTools(tools.filter((tool) => tool.name !== toolName)),
    async disconnect() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map((session) => session.transport.close()));
    },
    async close() {
      await Promise.all([...sessions.values()].map((session) => session.transport.close()));
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error === undefined ? resolve() : reject(error)));
        http.closeAllConnections();
      });
    },
  };
}

async function readRequest(incoming: IncomingMessage): Promise<FakeMcpHttpRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  const parsed = parseJson(body);
  const messages: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return {
    method: incoming.method ?? 'GET',
    path: new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname,
    headers: incoming.headers,
    body,
    rpcMethods: messages.flatMap((message) => {
      const method = (message as { method?: unknown } | null)?.method;
      return typeof method === 'string' ? [method] : [];
    }),
  };
}

function unauthorized(request: FakeMcpHttpRequest, bearerToken: string | undefined): FakeMcpHttpResponse | undefined {
  if (bearerToken === undefined || request.headers.authorization === `Bearer ${bearerToken}`) return undefined;
  return { status: 401, json: { error: 'unauthorized' } };
}

function send(response: ServerResponse, answer: FakeMcpHttpResponse): void {
  if (answer.json !== undefined) {
    response.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
    response.end(JSON.stringify(answer.json));
    return;
  }
  response.writeHead(answer.status, { ...answer.headers });
  response.end(answer.text ?? '');
}

function rpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

function parseJson(body: string): unknown {
  if (body === '') return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}
