/**
 * Scenario: MCP tool registration, execution, and output projection.
 *
 * Exercises ToolManager through its public tool surface with real MCP clients
 * where transport behavior matters, and transport-shaped fakes otherwise.
 * Run with `pnpm --filter @moonshot-ai/agent-core exec vitest run
 * test/mcp/tool-manager-mcp.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ContentPart, Tool } from '@moonshot-ai/kosong';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Agent } from '../../src/agent';
import { ToolManager } from '../../src/agent/tool';
import type { ExecutableTool } from '../../src/loop';
import { McpConnectionManager } from '../../src/mcp/connection-manager';
import { AlreadyAuthorizedError, type McpOAuthService } from '../../src/mcp/oauth';
import type { MCPClient } from '../../src/mcp/types';
import { testAgent } from '../agent/harness/agent';
import { executeTool } from '../tools/fixtures/execute-tool';

const MCP_OUTPUT_TRUNCATED_TEXT =
  '\n\n[Output truncated: exceeded 100000 character limit. ' +
  'Use pagination or more specific queries to get remaining content.]';

function fakeAgent(calls: unknown[] = [], mcp?: McpConnectionManager): Agent {
  return {
    records: {
      observabilityReady: true,
      logRecord(record: unknown) {
        calls.push(record);
      },
    },
    config: {
      data: () => ({ provider: undefined }),
    },
    goal: {
      getGoal: () => ({ goal: null }),
    },
    mcp,
    emitEvent() {},
  } as unknown as Agent;
}

function fakeClient(): MCPClient {
  return {
    async listTools() {
      return [
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
      ];
    },
    async callTool(name, args) {
      if (name === 'echo') {
        return { content: [{ type: 'text', text: String(args['text']) }], isError: false };
      }
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    },
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolveValue: (value: T) => void = () => {
    /* replaced by the Promise constructor */
  };
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

// Mirrors `connection-manager.connectAndDiscoverTools` — projects an MCP
// client's `listTools()` output into the kosong `Tool` shape that
// `ToolManager.registerMcpServer` expects. Tests can hand the same client into
// `registerMcpServer` so the wrapped `execute` flow hits a real `callTool`.
async function discoverTools(client: MCPClient): Promise<Tool[]> {
  const defs = await client.listTools();
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.inputSchema as Record<string, unknown>,
  }));
}

interface RestartableHttpMcpServer {
  readonly url: string;
  readonly initializeCount: () => number;
  readonly invalidSessionCount: () => number;
  readonly pauseNextInitialization: () => {
    readonly started: Promise<void>;
    readonly resume: () => void;
  };
  readonly restart: (options?: {
    readonly invalidSessionStatus?: 400 | 404;
    readonly rejectInitializationWith?: string;
    readonly rejectToolCallsAfterReconnect?: boolean;
  }) => void;
  readonly close: () => Promise<void>;
}

async function startRestartableHttpMcpServer(): Promise<RestartableHttpMcpServer> {
  const servers: McpServer[] = [];
  let activeTransport: StreamableHTTPServerTransport | undefined;
  let initializeCount = 0;
  let invalidSessionCount = 0;
  let invalidSessionStatus: 400 | 404 = 400;
  let rejectInitializationWith: string | undefined;
  let rejectToolCallsAfterReconnect = false;
  let initializationPause:
    | {
        readonly started: () => void;
        readonly resumed: Promise<void>;
      }
    | undefined;

  const createTransport = async (): Promise<StreamableHTTPServerTransport> => {
    const mcpServer = new McpServer({ name: 'restartable-http', version: '0.0.1' });
    mcpServer.registerTool(
      'echo',
      { description: 'Echoes text', inputSchema: { text: z.string() } },
      ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await mcpServer.connect(transport);
    servers.push(mcpServer);
    activeTransport = transport;
    initializeCount += 1;
    return transport;
  };

  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      const body = req.method === 'POST' ? await readJsonRequest(req) : undefined;
      const method =
        typeof body === 'object' &&
        body !== null &&
        'method' in body &&
        typeof body.method === 'string'
          ? body.method
          : undefined;
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId === undefined && method === 'initialize' && initializationPause !== undefined) {
        const pause = initializationPause;
        initializationPause = undefined;
        pause.started();
        await pause.resumed;
      }
      if (
        sessionId === undefined &&
        method === 'initialize' &&
        rejectInitializationWith !== undefined
      ) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end(rejectInitializationWith);
        return;
      }
      if (
        typeof sessionId === 'string' &&
        (activeTransport === undefined ||
          sessionId !== activeTransport.sessionId ||
          (rejectToolCallsAfterReconnect && method === 'tools/call'))
      ) {
        invalidSessionCount += 1;
        if (invalidSessionStatus === 404) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end(`Unknown session id '${sessionId}'`);
          return;
        }
        res.writeHead(invalidSessionStatus, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id:
              typeof body === 'object' && body !== null && 'id' in body
                ? body.id
                : 1,
            error: {
              code: -32600,
              message: `Unknown session id '${sessionId}' for 'tools/call'; client should reinitialize`,
            },
          }),
        );
        return;
      }

      const transport =
        sessionId === undefined ? await createTransport() : activeTransport;
      if (transport === undefined) {
        throw new Error('expected an active MCP transport');
      }
      await transport.handleRequest(req, res, body);
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    initializeCount: () => initializeCount,
    invalidSessionCount: () => invalidSessionCount,
    pauseNextInitialization: () => {
      const started = createSignal();
      const resumed = createSignal();
      initializationPause = {
        started: started.resolve,
        resumed: resumed.promise,
      };
      return {
        started: started.promise,
        resume: resumed.resolve,
      };
    },
    restart: (options = {}) => {
      activeTransport = undefined;
      invalidSessionStatus = options.invalidSessionStatus ?? 400;
      rejectInitializationWith = options.rejectInitializationWith;
      rejectToolCallsAfterReconnect = options.rejectToolCallsAfterReconnect ?? false;
    },
    async close() {
      await Promise.allSettled(servers.map((server) => server.close()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function readJsonRequest(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function createSignal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = () => {
      settle();
    };
  });
  return { promise, resolve };
}

async function connectRestartableMcp(server: RestartableHttpMcpServer): Promise<{
  readonly mcp: McpConnectionManager;
  readonly tool: ExecutableTool;
}> {
  const mcp = new McpConnectionManager();
  await mcp.connectAll({
    remote: {
      transport: 'http',
      url: server.url,
      startupTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
    },
  });
  const tm = new ToolManager(fakeAgent([], mcp));
  tm.setActiveTools(['mcp__*']);
  const tool = tm.loopTools.find((candidate) => candidate.name === 'mcp__remote__echo');
  if (tool === undefined) throw new Error('expected the remote echo tool');
  return { mcp, tool };
}

describe('ToolManager MCP integration', () => {
  it('registers MCP tools under qualified names with source=mcp', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client = fakeClient();
    tm.registerMcpServer('local server', client, await discoverTools(client));

    const infos = [...tm.toolInfos()].filter((i) => i.source === 'mcp');
    expect(infos.map((i) => i.name).toSorted()).toEqual([
      'mcp__local_server__echo',
      'mcp__local_server__noop',
    ]);
    for (const info of infos) {
      expect(info.active).toBe(true);
    }

    const loop = tm.loopTools.map((t) => t.name);
    expect(loop).toContain('mcp__local_server__echo');
    expect(loop).toContain('mcp__local_server__noop');
  });

  it('respects enabledTools filter when registering', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client = fakeClient();
    tm.registerMcpServer('s', client, await discoverTools(client), new Set(['echo']));

    const mcpNames = [...tm.toolInfos()].filter((i) => i.source === 'mcp').map((i) => i.name);
    expect(mcpNames).toEqual(['mcp__s__echo']);
  });

  it('unregisterMcpServer removes every tool the server contributed', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client = fakeClient();

    const before = tm.registerMcpServer('s', client, await discoverTools(client));
    expect(before.registered.length).toBe(2);
    expect(before.collisions).toEqual([]);
    expect(tm.loopTools.length).toBe(2);

    expect(tm.unregisterMcpServer('s')).toBe(true);
    expect([...tm.toolInfos()].filter((i) => i.source === 'mcp')).toEqual([]);
    expect(tm.loopTools).toEqual([]);
    expect(tm.unregisterMcpServer('s')).toBe(false);
  });

  it('reports same-server qualified-name collisions and keeps only the first tool', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const colliding: MCPClient = {
      async listTools() {
        return [
          { name: 'a b', description: 'first', inputSchema: { type: 'object', properties: {} } },
          {
            name: 'a__b',
            description: 'collides after collapse',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
    };
    const result = tm.registerMcpServer('srv', colliding, await discoverTools(colliding));

    expect(result.registered).toEqual(['mcp__srv__a_b']);
    expect(result.collisions).toEqual([
      {
        qualified: 'mcp__srv__a_b',
        toolName: 'a__b',
        collidesWith: { kind: 'same_server', toolName: 'a b' },
      },
    ]);
    const mcpNames = [...tm.toolInfos()].filter((i) => i.source === 'mcp').map((i) => i.name);
    expect(mcpNames).toEqual(['mcp__srv__a_b']);
  });

  it('reports cross-server collisions instead of silently overwriting another server tool', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const firstClient: MCPClient = {
      async listTools() {
        return [
          { name: 'shared', description: 'first', inputSchema: { type: 'object', properties: {} } },
        ];
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'first' }], isError: false };
      },
    };
    const secondClient: MCPClient = {
      async listTools() {
        return [
          {
            name: 'shared',
            description: 'second',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'second' }], isError: false };
      },
    };

    // Both servers collapse to the same sanitized form ("srv_a"), so the
    // qualified name `mcp__srv_a__shared` is contested between them.
    tm.registerMcpServer('srv a', firstClient, await discoverTools(firstClient));
    const result = tm.registerMcpServer('srv__a', secondClient, await discoverTools(secondClient));

    expect(result.registered).toEqual([]);
    expect(result.collisions).toEqual([
      {
        qualified: 'mcp__srv_a__shared',
        toolName: 'shared',
        collidesWith: { kind: 'other_server', serverName: 'srv a' },
      },
    ]);
    // First server's tool still wins and stays callable.
    expect(tm.loopTools.map((t) => t.name)).toEqual(['mcp__srv_a__shared']);
  });

  it('re-registering the same server replaces its previous tool set', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const firstClient = fakeClient();
    const secondClient: MCPClient = {
      async listTools() {
        return [
          {
            name: 'only',
            description: 'Sole tool',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return { content: [], isError: false };
      },
    };

    tm.registerMcpServer('s', firstClient, await discoverTools(firstClient));
    tm.registerMcpServer('s', secondClient, await discoverTools(secondClient));

    const mcpNames = [...tm.toolInfos()].filter((i) => i.source === 'mcp').map((i) => i.name);
    expect(mcpNames).toEqual(['mcp__s__only']);
  });

  it('does not write set_active_tools records when registering an MCP server', async () => {
    const calls: unknown[] = [];
    const tm = new ToolManager(fakeAgent(calls));
    const client = fakeClient();
    tm.registerMcpServer('s', client, await discoverTools(client));

    // MCP tools live in mcpTools map, separate from enabledTools, so
    // registering an MCP server does not mutate enabledTools and does not
    // emit a set_active_tools record. This is what keeps wire.jsonl free of
    // synthetic mutations on session resume.
    expect(calls).not.toContainEqual(
      expect.objectContaining({ type: 'tools.set_active_tools' }),
    );
    expect(calls).not.toContainEqual(
      expect.objectContaining({ type: 'tools.register_mcp_server' }),
    );
  });

  it('re-enables all registered MCP tools when re-registering a server', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const firstClient = fakeClient();
    const secondClient = fakeClient();

    tm.registerMcpServer('s', firstClient, await discoverTools(firstClient));
    tm.unregisterMcpServer('s');
    expect(tm.loopTools).toEqual([]);
    tm.registerMcpServer('s', secondClient, await discoverTools(secondClient));

    const mcpInfos = [...tm.toolInfos()]
      .filter((i) => i.source === 'mcp')
      .map((i) => ({ name: i.name, active: i.active }));
    expect(mcpInfos).toEqual([
      { name: 'mcp__s__echo', active: true },
      { name: 'mcp__s__noop', active: true },
    ]);
    expect(tm.loopTools.map((t) => t.name)).toEqual(['mcp__s__echo', 'mcp__s__noop']);
  });

  it('executing a wrapped MCP tool dispatches to client.callTool', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client = fakeClient();
    tm.registerMcpServer('s', client, await discoverTools(client));
    const echo = tm.loopTools.find((t) => t.name === 'mcp__s__echo');
    expect(echo).toBeDefined();

    const result = await executeTool(echo!, {
      turnId: '1',
      toolCallId: 'tc-1',
      args: { text: 'hello world' },
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(false);
    expect(result.output).toBe('hello world');
  });

  it('does not replay a tool call when ConnectionClosed races with a replacement client', async () => {
    let recoveryStarted = false;
    let replacementCalls = 0;
    const staleClient: MCPClient = {
      ...fakeClient(),
      async callTool() {
        recoveryStarted = true;
        throw new McpError(ErrorCode.ConnectionClosed, 'Connection closed after dispatch');
      },
    };
    const replacementClient: MCPClient = {
      ...fakeClient(),
      async callTool() {
        replacementCalls += 1;
        return { content: [{ type: 'text', text: 'duplicate' }], isError: false };
      },
    };
    const mcp = {
      list: () => [],
      onStatusChange: () => () => {},
      inFlightReconnect: () => (recoveryStarted ? Promise.resolve() : undefined),
      resolved: () =>
        recoveryStarted
          ? {
              client: replacementClient,
              tools: [],
              rawTools: [],
              enabledNames: new Set<string>(),
            }
          : {
              client: staleClient,
              tools: [],
              rawTools: [],
              enabledNames: new Set<string>(),
            },
    } as unknown as McpConnectionManager;
    const tm = new ToolManager(fakeAgent([], mcp));
    tm.setActiveTools(['mcp__*']);
    tm.registerMcpServer('s', staleClient, await discoverTools(staleClient));
    const echo = tm.loopTools.find((tool) => tool.name === 'mcp__s__echo');

    await expect(
      executeTool(echo!, {
        turnId: '1',
        toolCallId: 'tc-ambiguous-close',
        args: { text: 'side effect' },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.ConnectionClosed });
    expect(replacementCalls).toBe(0);
  });

  it('waits for a public reconnect before calling the replacement client', async () => {
    const server = await startRestartableHttpMcpServer();
    const { mcp, tool } = await connectRestartableMcp(server);
    const pause = server.pauseNextInitialization();
    const reconnect = mcp.reconnect('remote');
    try {
      await pause.started;
      const call = executeTool(tool, {
        turnId: '1',
        toolCallId: 'tc-join-public-reconnect',
        args: { text: 'after manual reconnect' },
        signal: new AbortController().signal,
      });

      pause.resume();

      await expect(call).resolves.toMatchObject({ output: 'after manual reconnect' });
      await reconnect;
      expect(server.initializeCount()).toBe(2);
    } finally {
      pause.resume();
      await reconnect.catch(() => {});
      await mcp.shutdown();
      await server.close();
    }
  }, 15_000);

  it('aborts a caller waiting for a shared reconnect without cancelling the reconnect', async () => {
    const server = await startRestartableHttpMcpServer();
    const { mcp, tool } = await connectRestartableMcp(server);
    const pause = server.pauseNextInitialization();
    const reconnect = mcp.reconnectAndJoin('remote');
    try {
      await pause.started;
      const controller = new AbortController();
      const call = executeTool(tool, {
        turnId: '1',
        toolCallId: 'tc-abort-shared-reconnect',
        args: { text: 'cancelled waiter' },
        signal: controller.signal,
      });

      controller.abort();

      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      pause.resume();
      await reconnect;
      await expect(
        executeTool(tool, {
          turnId: '2',
          toolCallId: 'tc-after-aborted-waiter',
          args: { text: 'shared reconnect completed' },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ output: 'shared reconnect completed' });
    } finally {
      pause.resume();
      await reconnect.catch(() => {});
      await mcp.shutdown();
      await server.close();
    }
  }, 15_000);

  it('aborts an OAuth waiter without cancelling the shared reconnect', async () => {
    const reconnect = createDeferred<void>();
    const reconnectStarted = createDeferred<void>();
    let reconnectFinished = false;
    void reconnect.promise.then(() => {
      reconnectFinished = true;
    });
    const oauthService = {
      beginAuthorization: async () => {
        throw new AlreadyAuthorizedError('remote');
      },
    } as unknown as McpOAuthService;
    const mcp = {
      list: () => [
        {
          name: 'remote',
          transport: 'http',
          status: 'needs-auth',
          toolCount: 0,
        },
      ],
      onStatusChange: () => () => {},
      oauthService,
      getRemoteServerUrl: () => 'https://example.com/mcp',
      reconnect: () => {
        reconnectStarted.resolve();
        return reconnect.promise;
      },
    } as unknown as McpConnectionManager;
    const tm = new ToolManager(fakeAgent([], mcp));
    tm.setActiveTools(['mcp__*']);
    const auth = tm.loopTools.find((tool) => tool.name === 'mcp__remote__authenticate');
    const controller = new AbortController();
    const call = executeTool(auth!, {
      turnId: '1',
      toolCallId: 'tc-abort-oauth-reconnect',
      args: {},
      signal: controller.signal,
    });

    await reconnectStarted.promise;
    controller.abort();
    let outcome: Awaited<typeof call> | undefined;
    void call.then((result) => {
      outcome = result;
    });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(outcome).toMatchObject({ isError: true });
      expect(reconnectFinished).toBe(false);
    } finally {
      reconnect.resolve();
      await reconnect.promise;
    }
  });

  it('reinitializes a Streamable HTTP session when the server invalidates its session id', async () => {
    const server = await startRestartableHttpMcpServer();
    const { mcp, tool } = await connectRestartableMcp(server);
    try {
      expect(mcp.get('remote')?.status).toBe('connected');
      expect(server.initializeCount()).toBe(1);

      server.restart();
      const result = await executeTool(tool, {
        turnId: '1',
        toolCallId: 'tc-session-reinitialized',
        args: { text: 'after restart' },
        signal: new AbortController().signal,
      });

      expect(result.output).toBe('after restart');
      expect(server.initializeCount()).toBe(2);
      expect(server.invalidSessionCount()).toBeGreaterThanOrEqual(1);
      expect(mcp.get('remote')?.status).toBe('connected');

      const nextResult = await executeTool(tool, {
        turnId: '2',
        toolCallId: 'tc-reconnected-session-reused',
        args: { text: 'next call' },
        signal: new AbortController().signal,
      });
      expect(nextResult.output).toBe('next call');
      expect(server.initializeCount()).toBe(2);
    } finally {
      await mcp.shutdown();
      await server.close();
    }
  }, 15_000);

  it('reinitializes a Streamable HTTP session after the standard HTTP 404 signal', async () => {
    const server = await startRestartableHttpMcpServer();
    const { mcp, tool } = await connectRestartableMcp(server);
    try {
      server.restart({ invalidSessionStatus: 404 });

      const result = await executeTool(tool, {
        turnId: '1',
        toolCallId: 'tc-standard-session-expiry',
        args: { text: 'after 404' },
        signal: new AbortController().signal,
      });

      expect(result.output).toBe('after 404');
      expect(server.initializeCount()).toBe(2);
      expect(server.invalidSessionCount()).toBe(1);
      expect(mcp.get('remote')?.status).toBe('connected');
    } finally {
      await mcp.shutdown();
      await server.close();
    }
  }, 15_000);

  it('retries only once when the replacement session is also rejected', async () => {
    const server = await startRestartableHttpMcpServer();
    const { mcp, tool } = await connectRestartableMcp(server);
    try {
      server.restart({ rejectToolCallsAfterReconnect: true });

      await expect(
        executeTool(tool, {
          turnId: '1',
          toolCallId: 'tc-retry-still-invalid',
          args: { text: 'never returned' },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/Unknown session id/);
      expect(server.initializeCount()).toBe(2);
      expect(server.invalidSessionCount()).toBe(2);
      expect(mcp.get('remote')?.status).toBe('connected');
    } finally {
      await mcp.shutdown();
      await server.close();
    }
  }, 15_000);

  it('reports both the expired session and a failed reinitialization', async () => {
    const server = await startRestartableHttpMcpServer();
    const { mcp, tool } = await connectRestartableMcp(server);
    try {
      server.restart({ rejectInitializationWith: 'MCP service unavailable for maintenance' });

      const call = executeTool(tool, {
        turnId: '1',
        toolCallId: 'tc-reinitialization-failed',
        args: { text: 'never returned' },
        signal: new AbortController().signal,
      });
      await expect(call).rejects.toThrow(/Unknown session id/);
      await expect(call).rejects.toThrow(/reinitializing the MCP session also failed/);
      await expect(call).rejects.toThrow(/MCP service unavailable for maintenance/);
      expect(mcp.get('remote')?.status).toBe('failed');
    } finally {
      await mcp.shutdown();
      await server.close();
    }
  }, 15_000);

  it('truncates oversized MCP text output with a clear notice', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'big',
            description: 'Returns a huge text',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [{ type: 'text', text: 'x'.repeat(100_001) }],
          isError: false,
        };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const big = tm.loopTools.find((t) => t.name === 'mcp__s__big');

    const result = await executeTool(big!, {
      turnId: '1',
      toolCallId: 'tc-big-text',
      args: {},
      signal: new AbortController().signal,
    });

    // applyOutputLimits slices to the budget and merges the truncation
    // notice into the last text part so the single-text case still collapses
    // to a plain string.
    expect(result.isError).toBe(false);
    expect(result.output).toBe('x'.repeat(100_000) + MCP_OUTPUT_TRUNCATED_TEXT);
  });

  it('wraps modestly-sized MCP image output in mcp_tool_result companions', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'snap',
            description: 'Returns a small image',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [{ type: 'image', data: 'x'.repeat(100_000), mimeType: 'image/png' }],
          isError: false,
        };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const snap = tm.loopTools.find((t) => t.name === 'mcp__s__snap');

    const result = await executeTool(snap!, {
      turnId: '1',
      toolCallId: 'tc-small-image',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(Array.isArray(result.output)).toBe(true);
    const parts = result.output as ContentPart[];
    // mcpResultToExecutableOutput wraps media-only output in text companions
    // tagged with the qualified tool name; the image_url itself is preserved
    // intact (~75 KiB raw, well below the 10 MiB per-part cap).
    expect(parts).toEqual([
      { type: 'text', text: '<mcp_tool_result name="mcp__s__snap">' },
      {
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,' + 'x'.repeat(100_000) },
      },
      { type: 'text', text: '</mcp_tool_result>' },
    ]);
  });

  it('drops MCP binary parts exceeding the per-part byte cap and substitutes a notice', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    // 14 MiB base64 ≈ 10.5 MiB raw — just above the 10 MiB per-part cap.
    const huge = 'x'.repeat(14 * 1024 * 1024);
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'huge_img',
            description: 'Returns an oversized image',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [{ type: 'image', data: huge, mimeType: 'image/png' }],
          isError: false,
        };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const tool = tm.loopTools.find((t) => t.name === 'mcp__s__huge_img');

    const result = await executeTool(tool!, {
      turnId: '1',
      toolCallId: 'tc-huge-image',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(Array.isArray(result.output)).toBe(true);
    const parts = result.output as ContentPart[];
    // applyOutputLimits swaps the oversized image for a per-part notice
    // inside the mcp_tool_result envelope: [open tag, dropped notice, close tag].
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({
      type: 'text',
      text: '<mcp_tool_result name="mcp__s__huge_img">',
    });
    expect(parts[1]?.type).toBe('text');
    expect((parts[1] as { text: string }).text).toContain('image_url dropped');
    expect((parts[1] as { text: string }).text).toContain('10 MB per-part limit');
    expect(parts[2]).toEqual({ type: 'text', text: '</mcp_tool_result>' });
    // The notice replaces the binary part; the *text* truncation marker must
    // not fire because the text character budget was never touched.
    const joined = parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    expect(joined).not.toContain('Output truncated');
  });

  it('large MCP image does not consume the text character budget', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'mixed',
            description: 'Returns text plus an image',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [
            { type: 'text', text: 'A'.repeat(100_000) },
            { type: 'image', data: 'B'.repeat(500_000), mimeType: 'image/png' },
          ],
          isError: false,
        };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const tool = tm.loopTools.find((t) => t.name === 'mcp__s__mixed');

    const result = await executeTool(tool!, {
      turnId: '1',
      toolCallId: 'tc-text-plus-image',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(Array.isArray(result.output)).toBe(true);
    const parts = result.output as ContentPart[];
    // Text fills the whole 100k budget; image must still survive intact and
    // the trailing truncation marker must not appear (text was not cut off).
    expect(parts).toEqual([
      { type: 'text', text: 'A'.repeat(100_000) },
      {
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,' + 'B'.repeat(500_000) },
      },
    ]);
  });

  it('oversized binary part does not affect neighboring small binary parts', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    const huge = 'x'.repeat(14 * 1024 * 1024);
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'mixed',
            description: 'Returns an oversized image plus a small audio clip',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [
            { type: 'image', data: huge, mimeType: 'image/png' },
            { type: 'audio', data: 'A'.repeat(1000), mimeType: 'audio/mpeg' },
          ],
          isError: false,
        };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const tool = tm.loopTools.find((t) => t.name === 'mcp__s__mixed');

    const result = await executeTool(tool!, {
      turnId: '1',
      toolCallId: 'tc-mixed-binary',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(Array.isArray(result.output)).toBe(true);
    const parts = result.output as ContentPart[];
    // Inside the mcp_tool_result envelope: [open tag, dropped image notice,
    // surviving audio, close tag]. The audio survives because each binary
    // part is measured against its own byte cap independently.
    expect(parts).toHaveLength(4);
    expect(parts[0]).toEqual({ type: 'text', text: '<mcp_tool_result name="mcp__s__mixed">' });
    expect(parts[1]?.type).toBe('text');
    expect((parts[1] as { text: string }).text).toContain('image_url dropped');
    expect(parts[2]).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'data:audio/mpeg;base64,' + 'A'.repeat(1000) },
    });
    expect(parts[3]).toEqual({ type: 'text', text: '</mcp_tool_result>' });
  });

  it('forwards the execution AbortSignal through the wrapped MCP tool', async () => {
    const tm = new ToolManager(fakeAgent());
    tm.setActiveTools(['mcp__*']);
    let receivedSignal: AbortSignal | undefined;
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'echo',
            description: 'Echoes back',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ];
      },
      async callTool(_name, args, signal) {
        receivedSignal = signal;
        return { content: [{ type: 'text', text: String(args['text']) }], isError: false };
      },
    };
    tm.registerMcpServer('s', client, await discoverTools(client));
    const echo = tm.loopTools.find((t) => t.name === 'mcp__s__echo');

    const controller = new AbortController();
    await executeTool(echo!, {
      turnId: '1',
      toolCallId: 'tc-signal',
      args: { text: 'hi' },
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  it('gates MCP tools by the active profile', async () => {
    const ctx = testAgent();
    const tm = ctx.agent.tools;
    const client = fakeClient();
    tm.registerMcpServer('local', client, await discoverTools(client));

    // A profile without any MCP pattern hides every MCP tool: they stay
    // registered (and visible in toolInfos) but inactive and out of the loop.
    ctx.agent.useProfile({
      name: 'no-mcp',
      systemPrompt: () => 'sys',
      tools: ['Read'],
    });
    expect(
      [...tm.toolInfos()]
        .filter((i) => i.source === 'mcp')
        .map((i) => ({ name: i.name, active: i.active })),
    ).toEqual([
      { name: 'mcp__local__echo', active: false },
      { name: 'mcp__local__noop', active: false },
    ]);
    expect(tm.loopTools.some((t) => t.name.startsWith('mcp__'))).toBe(false);

    // Adding `mcp__*` to the profile exposes them again.
    ctx.agent.useProfile({
      name: 'with-mcp',
      systemPrompt: () => 'sys',
      tools: ['Read', 'mcp__*'],
    });
    expect(
      [...tm.toolInfos()]
        .filter((i) => i.source === 'mcp')
        .map((i) => ({ name: i.name, active: i.active })),
    ).toEqual([
      { name: 'mcp__local__echo', active: true },
      { name: 'mcp__local__noop', active: true },
    ]);
    expect(tm.loopTools.map((t) => t.name)).toContain('mcp__local__echo');
  });

  it('a server-scoped MCP glob exposes only that server', async () => {
    const tm = new ToolManager(fakeAgent());
    const githubClient = fakeClient();
    const slackClient = fakeClient();
    tm.registerMcpServer('github', githubClient, await discoverTools(githubClient));
    tm.registerMcpServer('slack', slackClient, await discoverTools(slackClient));
    tm.setActiveTools(['mcp__github__*']);

    expect(tm.loopTools.map((t) => t.name).toSorted()).toEqual([
      'mcp__github__echo',
      'mcp__github__noop',
    ]);
  });

  it('an exact MCP tool name exposes only that tool', async () => {
    const tm = new ToolManager(fakeAgent());
    const client = fakeClient();
    tm.registerMcpServer('s', client, await discoverTools(client));
    tm.setActiveTools(['mcp__s__echo']);

    expect(tm.loopTools.map((t) => t.name)).toEqual(['mcp__s__echo']);
  });

  it('a server-scoped MCP deny glob hides that server under a broad allow', async () => {
    const tm = new ToolManager(fakeAgent());
    const githubClient = fakeClient();
    const slackClient = fakeClient();
    tm.registerMcpServer('github', githubClient, await discoverTools(githubClient));
    tm.registerMcpServer('slack', slackClient, await discoverTools(slackClient));
    tm.setActiveTools(['mcp__*'], ['mcp__github__*']);

    expect(tm.loopTools.map((t) => t.name).toSorted()).toEqual([
      'mcp__slack__echo',
      'mcp__slack__noop',
    ]);
    expect([...tm.toolInfos()].filter((i) => i.source === 'mcp')).toEqual([
      { name: 'mcp__github__echo', description: 'Echoes back', active: false, source: 'mcp' },
      { name: 'mcp__github__noop', description: 'Does nothing', active: false, source: 'mcp' },
      { name: 'mcp__slack__echo', description: 'Echoes back', active: true, source: 'mcp' },
      { name: 'mcp__slack__noop', description: 'Does nothing', active: true, source: 'mcp' },
    ]);
  });

  it('an exact MCP deny hides one tool while the server glob allows the rest', async () => {
    const tm = new ToolManager(fakeAgent());
    const client = fakeClient();
    tm.registerMcpServer('s', client, await discoverTools(client));
    tm.setActiveTools(['mcp__s__*'], ['mcp__s__echo']);

    expect(tm.loopTools.map((t) => t.name)).toEqual(['mcp__s__noop']);
  });

  it('a full mcp__* deny hides every MCP tool', async () => {
    const tm = new ToolManager(fakeAgent());
    const client = fakeClient();
    tm.registerMcpServer('s', client, await discoverTools(client));
    tm.setActiveTools(['mcp__*'], ['mcp__*']);

    expect(tm.loopTools.some((t) => t.name.startsWith('mcp__'))).toBe(false);
  });

  it('records the deny list alongside the active tools', async () => {
    const calls: unknown[] = [];
    const tm = new ToolManager(fakeAgent(calls));
    tm.setActiveTools(['Read', 'Bash', 'Grep'], ['Bash']);

    expect(calls[0]).toMatchObject({
      type: 'tools.set_active_tools',
      names: ['Read', 'Bash', 'Grep'],
      disallowedNames: ['Bash'],
    });
  });
});
