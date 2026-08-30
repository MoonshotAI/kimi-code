import type { ContentPart } from '#/kosong/contract/message';
import type { Tool as KosongTool } from '#/kosong/contract/tool';
import { Jimp } from 'jimp';
import { CallToolResultSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toDisposable } from '#/_base/di/lifecycle';
import { abortError } from '#/_base/utils/abort';
import type { Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import type { McpConnectionManager, McpServerEntry } from '#/mcpCore/connection-manager';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import type { MCPClient, MCPToolDefinition } from '#/mcpCore/types';
import { qualifyMcpToolName } from '#/mcpCore/tool-naming';
import type { ToolInfo } from '#/tool/toolContract';
import type { WireRecord } from '#/wire/record';
import { AgentProfile, type ProfileRuntime } from '#/actor/profile/profileAgentRuntime';
import { AgentTools, type AgentToolsRuntime } from '#/actor/toolExecutor/toolExecutorAgentRuntime';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  mcpServices,
  telemetryServices,
  type TestAgentContext,
} from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

import { discoverTools, executeTool, fakeMcpClient } from '../../mcpCore/stubs';

const MCP_OUTPUT_TRUNCATED_TEXT =
  '\n\n[Output truncated: exceeded 100000 character limit. ' +
  'Use pagination or more specific queries to get remaining content.]';

interface ResolvedServer {
  readonly client: MCPClient;
  readonly tools: readonly KosongTool[];
  readonly rawTools: readonly MCPToolDefinition[];
  readonly enabledNames: ReadonlySet<string>;
}

class FakeMcpManager {
  private readonly entries = new Map<string, McpServerEntry>();
  private readonly resolvedEntries = new Map<string, ResolvedServer>();
  private readonly listeners = new Set<(entry: McpServerEntry) => void>();
  readonly oauthService: McpOAuthService | undefined;

  constructor(options: { readonly oauthService?: McpOAuthService } = {}) {
    this.oauthService = options.oauthService;
  }

  list(): readonly McpServerEntry[] {
    return [...this.entries.values()];
  }

  get(name: string): McpServerEntry | undefined {
    return this.entries.get(name);
  }

  resolved(name: string): ResolvedServer | undefined {
    if (this.entries.get(name)?.status !== 'connected') return undefined;
    return this.resolvedEntries.get(name);
  }

  known(name: string): ResolvedServer | undefined {
    return this.resolvedEntries.get(name);
  }

  getRemoteServerUrl(name: string): string | undefined {
    return name === 'needs-auth' ? 'https://example.com/mcp' : undefined;
  }

  reconnectHandler: (name: string) => Promise<void> = async () => {};

  async reconnect(name: string): Promise<void> {
    await this.reconnectHandler(name);
  }

  private readonly inFlightReconnects = new Map<string, Promise<void>>();

  reconnectAndJoin(name: string): Promise<void> {
    const existing = this.inFlightReconnects.get(name);
    if (existing !== undefined) return existing;
    const work = this.reconnect(name).finally(() => {
      if (this.inFlightReconnects.get(name) === work) {
        this.inFlightReconnects.delete(name);
      }
    });
    this.inFlightReconnects.set(name, work);
    return work;
  }

  async waitForInitialLoad(): Promise<void> {}

  initialLoadDurationMs(): number {
    return 0;
  }

  onStatusChange(listener: (entry: McpServerEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setResolved(
    name: string,
    client: MCPClient,
    tools: readonly KosongTool[],
    enabledNames = new Set(tools.map((tool) => tool.name)),
    rawTools?: readonly MCPToolDefinition[],
  ): void {
    const resolvedRawTools =
      rawTools ??
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.parameters ?? {}) as MCPToolDefinition['inputSchema'],
      }));
    this.resolvedEntries.set(name, {
      client,
      tools,
      rawTools: resolvedRawTools,
      enabledNames,
    });
  }

  connect(name: string, options: { readonly transport?: 'stdio' | 'http' | 'sse' } = {}): void {
    const resolved = this.resolvedEntries.get(name);
    const entry: McpServerEntry = {
      name,
      transport: options.transport ?? 'stdio',
      status: 'connected',
      toolCount: resolved?.enabledNames.size ?? 0,
    };
    this.entries.set(name, entry);
    this.emit(entry);
  }

  needsAuth(name = 'needs-auth'): void {
    const entry: McpServerEntry = {
      name,
      transport: 'http',
      status: 'needs-auth',
      toolCount: 0,
    };
    this.entries.set(name, entry);
    this.emit(entry);
  }

  fail(name: string): void {
    const current = this.entries.get(name);
    if (current === undefined) return;
    const entry: McpServerEntry = { ...current, status: 'failed', toolCount: 0 };
    this.entries.set(name, entry);
    this.emit(entry);
  }

  pending(name: string): void {
    const current = this.entries.get(name);
    if (current === undefined) return;
    const entry: McpServerEntry = { ...current, status: 'pending', toolCount: 0 };
    this.entries.set(name, entry);
    this.emit(entry);
  }

  disconnect(name: string): void {
    const current = this.entries.get(name);
    if (current === undefined) return;
    const entry: McpServerEntry = { ...current, status: 'disabled', toolCount: 0 };
    this.emit(entry);
    this.entries.delete(name);
  }

  markRemoved(name: string): void {
    const current = this.entries.get(name);
    if (current === undefined) return;
    const entry: McpServerEntry = { ...current, status: 'removed', toolCount: 0 };
    this.entries.set(name, entry);
    this.emit(entry);
  }

  private emit(entry: McpServerEntry): void {
    for (const listener of this.listeners) {
      listener(entry);
    }
  }
}

describe('AgentTools MCP provider', () => {
  let ctx: TestAgentContext;
  let tools: AgentToolsRuntime;
  let events: Event2[];
  let telemetryEvents: TelemetryRecord[];
  let persistence: InMemoryWireRecordPersistence;

  beforeEach(() => {
    events = [];
    telemetryEvents = [];
    persistence = new InMemoryWireRecordPersistence();
  });
  afterEach(async () => {
    await ctx?.dispose();
  });

  function createService(
    manager: FakeMcpManager,
    ready: Promise<void> = Promise.resolve(),
    isBaselineServer: (name: string) => boolean = () => true,
  ): AgentToolsRuntime {
    ctx = createTestAgent(
      mcpServices({ manager: manager as unknown as McpConnectionManager, ready, isBaselineServer }),
      telemetryServices(recordingTelemetry(telemetryEvents)),
      { persistence },
    );
    ctx.get(IEventBus).subscribe((event) => events.push(event));
    tools = ctx.resolve(AgentTools);
    return tools;
  }

  function mcpToolInfos(manager: FakeMcpManager): ToolInfo[] {
    const names = new Set<string>();
    for (const entry of manager.list()) {
      if (entry.status === 'needs-auth') names.add(`mcp__${entry.name}__authenticate`);
      const resolved = manager.known(entry.name);
      for (const tool of resolved?.tools ?? []) {
        if (resolved?.enabledNames.has(tool.name)) names.add(qualifyMcpToolName(entry.name, tool.name));
      }
    }
    return [...names]
      .filter((name) => tools.resolve(name) !== undefined)
      .map((name) => ({ name, description: '', parameters: {}, source: 'mcp' as const }));
  }

  it('delegates list / status events to the connection manager', async () => {
    const manager = new FakeMcpManager();
    manager.setResolved('s1', fakeMcpClient(), await discoverTools(fakeMcpClient()));
    manager.setResolved('s2', fakeMcpClient(), await discoverTools(fakeMcpClient()));
    createService(manager);

    const statuses: string[] = [];
    manager.onStatusChange((e) => statuses.push(`${e.name}:${e.status}`));

    manager.connect('s1');
    manager.connect('s2');
    expect(mcpToolInfos(manager)).toHaveLength(4);
    expect(manager.list().map((e) => e.name).toSorted()).toEqual(['s1', 's2']);

    manager.disconnect('s1');
    expect(manager.list().map((e) => e.name)).toEqual(['s2']);
    expect(statuses).toEqual(['s1:connected', 's2:connected', 's1:disabled']);
  });

  it('holds tool execution until the session MCP handle is ready', async () => {
    const manager = new FakeMcpManager();
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    createService(manager, ready);
    let settled = false;
    void ctx.get(ISessionMcpHandle).ready.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseReady();
    await ctx.get(ISessionMcpHandle).ready;
    expect(settled).toBe(true);
  });

  it('resolves AgentTools through the lifecycle with no MCP servers', () => {
    const created = createService(new FakeMcpManager());
    expect(created).toBe(tools);
    expect(mcpToolInfos(new FakeMcpManager())).toEqual([]);
  });

  it('registers connected MCP tools under qualified names with source=mcp', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('local server', client, await discoverTools(client));
    createService(manager);

    manager.connect('local server');

    const infos = mcpToolInfos(manager);
    expect(infos.map((info) => info.name).toSorted()).toEqual([
      'mcp__local_server__echo',
      'mcp__local_server__noop',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.list.updated',
        reason: 'mcp.connected',
        serverName: 'local server',
      }),
    );
  });

  it('ignores status changes from servers outside the session baseline', async () => {
    const manager = new FakeMcpManager();
    const lateClient = fakeMcpClient();
    manager.setResolved('late server', lateClient, await discoverTools(lateClient));
    const baseClient = fakeMcpClient();
    manager.setResolved('base server', baseClient, await discoverTools(baseClient));
    createService(manager, Promise.resolve(), (name) => name === 'base server');

    const mcpToolNames = () => mcpToolInfos(manager).map((tool) => tool.name);

    manager.connect('late server');

    expect(mcpToolNames()).toEqual([]);
    expect(
      events.filter(
        (event) => event.type === 'mcp.server.status' || event.type === 'tool.list.updated',
      ),
    ).toEqual([]);

    manager.connect('base server');

    expect(mcpToolNames().toSorted()).toEqual([
      'mcp__base_server__echo',
      'mcp__base_server__noop',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'mcp.server.status',
        server: expect.objectContaining({ name: 'base server', status: 'connected' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.list.updated',
        reason: 'mcp.connected',
        serverName: 'base server',
      }),
    );
  });

  it('respects the enabledNames filter when registering connected tools', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('s', client, await discoverTools(client), new Set(['echo']));
    createService(manager);

    manager.connect('s');

    const names = mcpToolInfos(manager).map((tool) => tool.name);
    expect(names).toEqual(['mcp__s__echo']);
  });

  it('unregisters every tool when the server disconnects and emits mcp.disconnected', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);

    manager.connect('s');
    expect(mcpToolInfos(manager)).toHaveLength(2);

    manager.disconnect('s');

    expect(mcpToolInfos(manager)).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.list.updated',
        reason: 'mcp.disconnected',
        serverName: 's',
      }),
    );
  });

  it('keeps tools registered when the server is tombstoned as removed, and calls fail with a removal notice', async () => {
    const manager = new FakeMcpManager();
    const counter = { calls: 0 };
    const client = countingClient(fakeMcpClient(), counter);
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');
    expect(mcpToolInfos(manager)).toHaveLength(2);

    manager.markRemoved('s');

    const registered = mcpToolInfos(manager);
    expect(registered).toHaveLength(2);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'tool.list.updated', reason: 'mcp.disconnected' }),
    );

    const echo = tools.resolve('mcp__s__echo');
    expect(echo).toBeDefined();
    const result = await executeTool(echo!, {
      turnId: 1,
      toolCallId: 'tc-removed',
      args: { text: 'hello world' },
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('has been removed');
    expect(counter.calls).toBe(0);
  });

  it('does not register tools for a server tombstoned before the agent attached', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('s', client, await discoverTools(client));
    manager.connect('s');
    manager.markRemoved('s');

    createService(manager);

    expect(mcpToolInfos(manager)).toEqual([]);
  });

  it('reports same-server qualified-name collisions and keeps only the first tool', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient([
      { name: 'a b', description: 'first', inputSchema: { type: 'object', properties: {} } },
      {
        name: 'a__b',
        description: 'collides after collapse',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    manager.setResolved('srv', client, await discoverTools(client));
    createService(manager);

    manager.connect('srv');

    const names = mcpToolInfos(manager).map((tool) => tool.name);
    expect(names).toEqual(['mcp__srv__a_b']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        code: 'mcp.tool_name_collision',
      }),
    );
  });

  it('reports cross-server collisions instead of silently overwriting another server tool', async () => {
    const manager = new FakeMcpManager();
    const firstClient = fakeMcpClient([
      { name: 'shared', description: 'first', inputSchema: { type: 'object', properties: {} } },
    ]);
    const secondClient = fakeMcpClient([
      { name: 'shared', description: 'second', inputSchema: { type: 'object', properties: {} } },
    ]);
    manager.setResolved('srv a', firstClient, await discoverTools(firstClient));
    manager.setResolved('srv__a', secondClient, await discoverTools(secondClient));
    createService(manager);

    manager.connect('srv a');
    manager.connect('srv__a');

    expect(mcpToolInfos(manager).map((tool) => tool.name)).toEqual([
      'mcp__srv_a__shared',
    ]);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
  });

  it('re-registering the same server replaces its previous tool set', async () => {
    const manager = new FakeMcpManager();
    const firstClient = fakeMcpClient();
    const secondClient = fakeMcpClient([
      { name: 'only', description: 'Sole tool', inputSchema: { type: 'object', properties: {} } },
    ]);
    manager.setResolved('s', firstClient, await discoverTools(firstClient));
    createService(manager);
    manager.connect('s');

    manager.setResolved('s', secondClient, await discoverTools(secondClient));
    manager.connect('s');

    const names = mcpToolInfos(manager).map((tool) => tool.name);
    expect(names).toEqual(['mcp__s__only']);
  });

  it('executing a wrapped MCP tool dispatches to client.callTool', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const echo = tools.resolve('mcp__s__echo');
    expect(echo).toBeDefined();
    const result = await executeTool(echo!, {
      turnId: 1,
      toolCallId: 'tc-1',
      args: { text: 'hello world' },
      signal: new AbortController().signal,
    });
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('hello world');
  });

  function throwingClient(
    base: MCPClient = fakeMcpClient(),
    onCall?: () => void,
    makeError: () => Error = () => new McpError(ErrorCode.ConnectionClosed, 'Connection closed'),
  ): MCPClient {
    return {
      listTools: () => base.listTools(),
      async callTool() {
        onCall?.();
        throw makeError();
      },
      async ping() {
        throw makeError();
      },
    };
  }

  function countingClient(base: MCPClient, counter: { calls: number }): MCPClient {
    return {
      listTools: () => base.listTools(),
      callTool: (name, args, signal) => {
        counter.calls += 1;
        return base.callTool(name, args, signal);
      },
      ping: (signal) => base.ping(signal),
    };
  }

  function deferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void;
  } {
    let resolvePromise!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolve) => {
      resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
  }

  it('reconnects the server and retries the call once when the transport dies', async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(fakeMcpClient(), () => manager.fail('s'));
    const freshCounter = { calls: 0 };
    const freshClient = countingClient(fakeMcpClient(), freshCounter);
    let reconnects = 0;
    manager.reconnectHandler = async (name) => {
      reconnects += 1;
      manager.setResolved(name, freshClient, await discoverTools(freshClient));
      manager.connect(name);
    };
    manager.setResolved('s', deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect('s');

    const echo = tools.resolve('mcp__s__echo');
    const result = await executeTool(echo!, {
      turnId: 1,
      toolCallId: 'tc-reconnect',
      args: { text: 'hello again' },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('hello again');
    expect(freshCounter.calls).toBe(1);
    expect(reconnects).toBe(1);
  });

  it('heals a server that died between turns when its tool is called again', async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(fakeMcpClient());
    const freshCounter = { calls: 0 };
    const freshClient = countingClient(fakeMcpClient(), freshCounter);
    let reconnects = 0;
    manager.reconnectHandler = async (name) => {
      reconnects += 1;
      manager.setResolved(name, freshClient, await discoverTools(freshClient));
      manager.connect(name);
    };
    manager.setResolved('s', deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect('s');

    manager.fail('s');

    const echo = tools.resolve('mcp__s__echo');
    expect(echo).toBeDefined();
    const result = await executeTool(echo!, {
      turnId: 1,
      toolCallId: 'tc-between-turns',
      args: { text: 'back from the dead' },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('back from the dead');
    expect(freshCounter.calls).toBe(1);
    expect(reconnects).toBe(1);
  });

  it('returns a non-transport MCP error without reconnecting the server', async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    const client: MCPClient = {
      listTools: () => base.listTools(),
      async callTool() {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid tool arguments');
      },
      ping: () => base.ping(),
    };
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const echo = tools.resolve('mcp__s__echo');
    await expect(
      executeTool(echo!, {
        turnId: 1,
        toolCallId: 'tc-non-transport-error',
        args: { text: 'hi' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Invalid tool arguments');
    expect(reconnects).toBe(0);
  });

  it('rethrows the original error when the server does not come back', async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(fakeMcpClient(), () => manager.fail('s'));
    manager.reconnectHandler = async (name) => {
      manager.fail(name);
    };
    manager.setResolved('s', deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect('s');

    const echo = tools.resolve('mcp__s__echo');
    await expect(
      executeTool(echo!, {
        turnId: 1,
        toolCallId: 'tc-still-dead',
        args: { text: 'hi' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Connection closed');
    expect(mcpToolInfos(manager)).toHaveLength(2);
  });

  it('reports both errors when the reconnect attempt itself fails', async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(fakeMcpClient(), () => manager.fail('s'));
    manager.reconnectHandler = async () => {
      throw new Error('spawn failed');
    };
    manager.setResolved('s', deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect('s');

    const echo = tools.resolve('mcp__s__echo');
    await expect(
      executeTool(echo!, {
        turnId: 1,
        toolCallId: 'tc-reconnect-fails',
        args: { text: 'hi' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Connection closed .*spawn failed/);
  });

  it('does not reconnect when the call was aborted', async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    const abortingClient: MCPClient = {
      listTools: () => base.listTools(),
      async callTool() {
        throw abortError('This operation was aborted');
      },
      ping: () => base.ping(),
    };
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved('s', abortingClient, await discoverTools(abortingClient));
    createService(manager);
    manager.connect('s');

    const echo = tools.resolve('mcp__s__echo');
    await expect(
      executeTool(echo!, {
        turnId: 1,
        toolCallId: 'tc-aborted',
        args: { text: 'hi' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('This operation was aborted');
    expect(reconnects).toBe(0);
  });

  it('dedupes concurrent reconnects from parallel failing tool calls', async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(fakeMcpClient(), () => manager.fail('s'));
    const freshClient = fakeMcpClient();
    let reconnects = 0;
    manager.reconnectHandler = async (name) => {
      reconnects += 1;
      manager.setResolved(name, freshClient, await discoverTools(freshClient));
      manager.connect(name);
    };
    manager.setResolved('s', deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect('s');

    const registry = tools;
    const echo = registry.resolve('mcp__s__echo');
    const noop = registry.resolve('mcp__s__noop');
    const [echoResult, noopResult] = await Promise.all([
      executeTool(echo!, {
        turnId: 1,
        toolCallId: 'tc-par-1',
        args: { text: 'one' },
        signal: new AbortController().signal,
      }),
      executeTool(noop!, {
        turnId: 1,
        toolCallId: 'tc-par-2',
        args: {},
        signal: new AbortController().signal,
      }),
    ]);

    expect(echoResult.output).toBe('one');
    expect(noopResult.output).toBe('ok');
    expect(reconnects).toBe(1);
  });

  it('keeps the shared reconnect alive when one parallel call is aborted', async () => {
    const manager = new FakeMcpManager();
    const reconnectStarted = deferred<void>();
    const reconnectReleased = deferred<void>();
    const deadClient = throwingClient(fakeMcpClient(), () => manager.fail('s'));
    const freshClient = fakeMcpClient();
    let reconnects = 0;
    manager.reconnectHandler = async (name) => {
      reconnects += 1;
      reconnectStarted.resolve();
      await reconnectReleased.promise;
      manager.setResolved(name, freshClient, await discoverTools(freshClient));
      manager.connect(name);
    };
    manager.setResolved('s', deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect('s');

    const registry = tools;
    const echo = registry.resolve('mcp__s__echo');
    const noop = registry.resolve('mcp__s__noop');
    const firstController = new AbortController();
    const firstCall = executeTool(echo!, {
      turnId: 1,
      toolCallId: 'tc-par-abort-1',
      args: { text: 'one' },
      signal: firstController.signal,
    });
    const secondCall = executeTool(noop!, {
      turnId: 1,
      toolCallId: 'tc-par-abort-2',
      args: {},
      signal: new AbortController().signal,
    });

    await reconnectStarted.promise;
    firstController.abort(new Error('cancelled by test'));
    await expect(firstCall).rejects.toThrow('cancelled by test');

    reconnectReleased.resolve();
    await expect(secondCall).resolves.toMatchObject({ output: 'ok' });
    expect(reconnects).toBe(1);
  });

  it('reconnects and retries when the call fails with a raw transport error the manager did not observe', async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(
      fakeMcpClient(),
      undefined,
      () => new TypeError('fetch failed'),
    );
    const freshClient = fakeMcpClient();
    let reconnects = 0;
    manager.reconnectHandler = async (name) => {
      reconnects += 1;
      manager.setResolved(name, freshClient, await discoverTools(freshClient));
      manager.connect(name);
    };
    manager.setResolved('s', deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect('s');

    const echo = tools.resolve('mcp__s__echo');
    const result = await executeTool(echo!, {
      turnId: 1,
      toolCallId: 'tc-raw-transport',
      args: { text: 'hello again' },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('hello again');
    expect(reconnects).toBe(1);
  });

  it('retries on the healed client without reconnecting again when the server already came back', async () => {
    const manager = new FakeMcpManager();
    const deadClient = throwingClient(fakeMcpClient(), undefined, () => new Error('Not connected'));
    const freshClient = fakeMcpClient();
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved('s', deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect('s');

    const registry = tools;
    const staleEcho = registry.resolve('mcp__s__echo');

    manager.setResolved('s', freshClient, await discoverTools(freshClient));
    manager.connect('s');

    const result = await executeTool(staleEcho!, {
      turnId: 1,
      toolCallId: 'tc-healed',
      args: { text: 'late call' },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('late call');
    expect(reconnects).toBe(0);
  });

  it('rethrows a malformed tool result without reconnecting or retrying when the server answered', async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    const malformed = CallToolResultSchema.safeParse({ content: [{ text: 'missing type' }] });
    if (malformed.success) throw new Error('expected the fixture result to fail validation');
    let calls = 0;
    const client: MCPClient = {
      listTools: () => base.listTools(),
      ping: () => base.ping(),
      async callTool() {
        calls += 1;
        throw malformed.error;
      },
    };
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const echo = tools.resolve('mcp__s__echo');
    await expect(
      executeTool(echo!, {
        turnId: 1,
        toolCallId: 'tc-malformed-result',
        args: { text: 'hi' },
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(malformed.error);
    expect(calls).toBe(1);
    expect(reconnects).toBe(0);
  });

  it('retries a transient transport failure in place without reconnecting', async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    let calls = 0;
    const flakyClient: MCPClient = {
      listTools: () => base.listTools(),
      ping: () => base.ping(),
      callTool: (name, args, signal) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new TypeError('fetch failed'));
        return base.callTool(name, args, signal);
      },
    };
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved('s', flakyClient, await discoverTools(flakyClient));
    createService(manager);
    manager.connect('s');

    const echo = tools.resolve('mcp__s__echo');
    const result = await executeTool(echo!, {
      turnId: 1,
      toolCallId: 'tc-transient',
      args: { text: 'hello again' },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('hello again');
    expect(calls).toBe(2);
    expect(reconnects).toBe(0);
  });

  it('reconnects when the transport failure persists past a successful probe', async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    let calls = 0;
    const deadClient: MCPClient = {
      listTools: () => base.listTools(),
      ping: () => base.ping(),
      async callTool() {
        calls += 1;
        throw new TypeError('fetch failed');
      },
    };
    const freshClient = fakeMcpClient();
    let reconnects = 0;
    manager.reconnectHandler = async (name) => {
      reconnects += 1;
      manager.setResolved(name, freshClient, await discoverTools(freshClient));
      manager.connect(name);
    };
    manager.setResolved('s', deadClient, await discoverTools(deadClient));
    createService(manager);
    manager.connect('s');

    const echo = tools.resolve('mcp__s__echo');
    const result = await executeTool(echo!, {
      turnId: 1,
      toolCallId: 'tc-persistent-transport',
      args: { text: 'hello again' },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('hello again');
    expect(calls).toBe(2);
    expect(reconnects).toBe(1);
  });

  it('abandons the retry when the call is aborted during the liveness probe', async () => {
    const manager = new FakeMcpManager();
    const base = fakeMcpClient();
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<void>();
    const client: MCPClient = {
      listTools: () => base.listTools(),
      async ping() {
        probeStarted.resolve();
        await releaseProbe.promise;
      },
      async callTool() {
        throw new TypeError('fetch failed');
      },
    };
    let reconnects = 0;
    manager.reconnectHandler = async () => {
      reconnects += 1;
    };
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const echo = tools.resolve('mcp__s__echo');
    const controller = new AbortController();
    const call = executeTool(echo!, {
      turnId: 1,
      toolCallId: 'tc-abort-during-probe',
      args: { text: 'hi' },
      signal: controller.signal,
    });
    await probeStarted.promise;
    controller.abort(new Error('cancelled by test'));
    releaseProbe.resolve();
    await expect(call).rejects.toThrow('cancelled by test');
    expect(reconnects).toBe(0);
  });

  it('truncates oversized MCP text output through the wrapped tool path', async () => {
    const manager = new FakeMcpManager();
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
      async ping() {},
    };
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const big = tools.resolve('mcp__s__big');
    const result = await executeTool(big!, {
      turnId: 1,
      toolCallId: 'tc-big-text',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('x'.repeat(100_000) + MCP_OUTPUT_TRUNCATED_TEXT);
  });

  it('wraps MCP image output in mcp_tool_result companions through the wrapped tool path', async () => {
    const manager = new FakeMcpManager();
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
      async ping() {},
    };
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const snap = tools.resolve('mcp__s__snap');
    const result = await executeTool(snap!, {
      turnId: 1,
      toolCallId: 'tc-small-image',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    expect(Array.isArray(result.output)).toBe(true);
    expect(result.output as ContentPart[]).toEqual([
      { type: 'text', text: '<mcp_tool_result name="mcp__s__snap">' },
      {
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,' + 'x'.repeat(100_000) },
      },
      { type: 'text', text: '</mcp_tool_result>' },
    ]);
  });

  it('reports MCP image compression telemetry through the wrapped tool path', async () => {
    const manager = new FakeMcpManager();
    const image = Buffer.from(
      await new Jimp({ width: 3600, height: 1800, color: 0x3366ccff }).getBuffer('image/png'),
    ).toString('base64');
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'shot',
            description: 'Returns a large image',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return {
          content: [{ type: 'image', data: image, mimeType: 'image/png' }],
          isError: false,
        };
      },
      async ping() {},
    };
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const shot = tools.resolve('mcp__s__shot');
    const result = await executeTool(shot!, {
      turnId: 1,
      toolCallId: 'tc-large-image',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeUndefined();
    const imageCompressEvents = telemetryEvents.filter((record) => record.event === 'image_compress');
    expect(imageCompressEvents).toHaveLength(1);
    const properties = imageCompressEvents[0]!.properties;
    expect(properties).toEqual(
      expect.objectContaining({
        source: 'mcp_tool_result',
        outcome: 'compressed',
        input_mime: 'image/png',
        original_width: 3600,
        original_height: 1800,
      }),
    );
    expect(properties?.['final_width']).toBeLessThanOrEqual(3000);
    expect(properties?.['final_height']).toBeLessThanOrEqual(3000);
  });

  it('forwards the execution AbortSignal through the wrapped MCP tool', async () => {
    const manager = new FakeMcpManager();
    let receivedSignal: AbortSignal | undefined;
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'echo',
            description: 'Echoes back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ];
      },
      async callTool(_name, args, signal) {
        receivedSignal = signal;
        return { content: [{ type: 'text', text: String(args['text']) }], isError: false };
      },
      async ping() {},
    };
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const controller = new AbortController();
    const echo = tools.resolve('mcp__s__echo');
    await executeTool(echo!, {
      turnId: 1,
      toolCallId: 'tc-signal',
      args: { text: 'hi' },
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  it('registers a synthetic authenticate tool when a server needs auth', () => {
    const oauthService = {
      beginAuthorization: async () => ({
        authorizationUrl: new URL('https://example.com/authorize'),
        complete: async () => {},
        cancel: async () => {},
      }),
    } as unknown as McpOAuthService;
    const manager = new FakeMcpManager({ oauthService });
    createService(manager);

    manager.needsAuth();

    const toolInfos = mcpToolInfos(manager);
    expect(toolInfos).toEqual([
      expect.objectContaining({
        name: 'mcp__needs-auth__authenticate',
        source: 'mcp',
      }),
    ]);
  });

  it('registers the synthetic authenticate tool for a server that settled needs-auth before attach', async () => {
    const oauthService = {
      beginAuthorization: async () => ({
        authorizationUrl: new URL('https://example.com/authorize'),
        complete: async () => {},
        cancel: async () => {},
      }),
    } as unknown as McpOAuthService;
    const manager = new FakeMcpManager({ oauthService });
    manager.needsAuth();

    createService(manager);

    const toolInfos = mcpToolInfos(manager);
    expect(toolInfos).toEqual([
      expect.objectContaining({
        name: 'mcp__needs-auth__authenticate',
        source: 'mcp',
      }),
    ]);
    expect(manager.get('needs-auth')).toEqual(
      expect.objectContaining({ name: 'needs-auth', status: 'needs-auth' }),
    );
  });

  it('keeps tools registered when a connected server fails so later calls can heal', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);

    manager.connect('s');
    manager.fail('s');

    expect(mcpToolInfos(manager)).toHaveLength(2);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'tool.list.updated', reason: 'mcp.failed' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'mcp.server.status',
        server: expect.objectContaining({ name: 's', status: 'failed' }),
      }),
    );
  });

  it('keeps tools registered while the server is reconnecting', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);

    manager.connect('s');
    manager.pending('s');

    expect(mcpToolInfos(manager)).toHaveLength(2);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'tool.list.updated', reason: 'mcp.disconnected' }),
    );
  });

  const RAW_QUERY: MCPToolDefinition = {
    name: 'query_range',
    description: 'Query a metrics range',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  };

  function collectDiscoveries(): {
    readonly records: { type: string; [key: string]: unknown }[];
    readonly off: { dispose(): void };
  } {
    const start = persistence.records.filter((record) => record.type === 'mcp.tools_discovered').length;
    const records = new Proxy([] as { type: string; [key: string]: unknown }[], {
      get: (_target, property) => Reflect.get(
        persistence.records.filter((record) => record.type === 'mcp.tools_discovered').slice(start),
        property,
      ),
    });
    return { records, off: toDisposable(() => {}) };
  }

  it('records tools/list once after restore and dedups unchanged reconnects', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient([RAW_QUERY]);
    const rawTools = await client.listTools();
    manager.setResolved(
      'grafana',
      client,
      await discoverTools(client),
      new Set(['query_range']),
      rawTools,
    );
    createService(manager);

    const { records, off } = collectDiscoveries();
    try {
      manager.connect('grafana');
      expect(records).toHaveLength(0);
      await ctx.restorePersisted();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        type: 'mcp.tools_discovered',
        serverName: 'grafana',
        tools: rawTools,
        enabledNames: ['query_range'],
      });
      expect(records[0]!['collisions']).toBeUndefined();

      manager.connect('grafana');
      expect(records).toHaveLength(1);

      manager.setResolved('grafana', client, await discoverTools(client), new Set(), rawTools);
      manager.connect('grafana');
      await ctx.wire.flush();
      expect(records).toHaveLength(2);
    } finally {
      off.dispose();
    }
  });

  it('parks a discovery observed before restore and flushes it after replay', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient([RAW_QUERY]);
    const rawTools = await client.listTools();
    manager.setResolved(
      'grafana',
      client,
      await discoverTools(client),
      new Set(['query_range']),
      rawTools,
    );
    createService(manager);

    const { records, off } = collectDiscoveries();
    try {
      manager.connect('grafana');
      expect(records).toHaveLength(0);
      await ctx.restorePersisted();
      expect(records).toHaveLength(1);
    } finally {
      off.dispose();
    }
  });

  it('snapshots enabledNames when parking a discovery before restore', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient([RAW_QUERY]);
    const rawTools = await client.listTools();
    const enabledNames = new Set(['query_range']);
    manager.setResolved(
      'grafana',
      client,
      await discoverTools(client),
      enabledNames,
      rawTools,
    );
    createService(manager);

    const { records, off } = collectDiscoveries();
    try {
      manager.connect('grafana');
      enabledNames.clear();
      enabledNames.add('mutated_after_observation');
      await ctx.restorePersisted();

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        type: 'mcp.tools_discovered',
        serverName: 'grafana',
        tools: rawTools,
        enabledNames: ['query_range'],
      });
    } finally {
      off.dispose();
    }
  });

  it('re-records when only the collision outcome changes', async () => {
    const manager = new FakeMcpManager();
    const occupant = fakeMcpClient([RAW_QUERY]);
    const occupantRaw = await occupant.listTools();
    manager.setResolved(
      'graf.ana',
      occupant,
      await discoverTools(occupant),
      new Set(['query_range']),
      occupantRaw,
    );
    createService(manager);
    manager.connect('graf.ana');
    await ctx.restorePersisted();

    const { records, off } = collectDiscoveries();
    try {
      const client = fakeMcpClient([RAW_QUERY]);
      const rawTools = await client.listTools();
      manager.setResolved(
        'graf_ana',
        client,
        await discoverTools(client),
        new Set(['query_range']),
        rawTools,
      );
      manager.connect('graf_ana');
      await ctx.wire.flush();
      expect(records).toHaveLength(1);
      expect(records[0]!['collisions']).toHaveLength(1);

      manager.disconnect('graf.ana');
      manager.connect('graf_ana');
      await ctx.wire.flush();
      expect(records).toHaveLength(2);
      expect(records[1]!['collisions']).toBeUndefined();
    } finally {
      off.dispose();
    }
  });
});

describe('AgentTools MCP provider + AgentProfile', () => {
  let ctx: TestAgentContext;
  let manager: FakeMcpManager;
  let profile: ProfileRuntime;
  let tools: AgentToolsRuntime;

  beforeEach(() => {
    manager = new FakeMcpManager();
    ctx = createTestAgent(mcpServices({ manager: manager as unknown as McpConnectionManager }));
    tools = ctx.resolve(AgentTools);
    profile = ctx.resolve(AgentProfile);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('gates MCP tools by the active profile', async () => {
    const client = fakeMcpClient();
    manager.setResolved('local', client, await discoverTools(client));
    manager.connect('local');

    profile.update({ activeToolNames: ['Read'] });
    expect(tools.isActive('mcp__local__echo', 'mcp')).toBe(false);
    expect(tools.isActive('mcp__local__noop', 'mcp')).toBe(false);

    profile.update({ activeToolNames: ['Read', 'mcp__*'] });
    expect(tools.isActive('mcp__local__echo', 'mcp')).toBe(true);
    expect(tools.isActive('mcp__local__noop', 'mcp')).toBe(true);
  });

  it('supports server-scoped and exact MCP active-tool patterns', async () => {
    const githubClient = fakeMcpClient();
    const slackClient = fakeMcpClient();
    manager.setResolved('github', githubClient, await discoverTools(githubClient));
    manager.setResolved('slack', slackClient, await discoverTools(slackClient));
    manager.connect('github');
    manager.connect('slack');

    profile.update({ activeToolNames: ['mcp__github__*'] });
    expect(tools.isActive('mcp__github__echo', 'mcp')).toBe(true);
    expect(tools.isActive('mcp__github__noop', 'mcp')).toBe(true);
    expect(tools.isActive('mcp__slack__echo', 'mcp')).toBe(false);

    profile.update({ activeToolNames: ['mcp__slack__echo'] });
    expect(tools.isActive('mcp__slack__echo', 'mcp')).toBe(true);
    expect(tools.isActive('mcp__github__echo', 'mcp')).toBe(false);
  });
});
