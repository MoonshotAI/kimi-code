import type { ContentPart } from '#/kosong/contract/message';
import type { Tool as KosongTool } from '#/kosong/contract/tool';
import { Jimp } from 'jimp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { McpConnectionManager, McpServerEntry } from '#/agent/mcp/connection-manager';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { AgentMcpService } from '#/agent/mcp/mcpService';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { McpOAuthService } from '#/agent/mcp/oauth/service';
import type { MCPClient, MCPToolDefinition } from '#/agent/mcp/types';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { McpDiscoveryModel } from '#/agent/mcp/mcpDiscoveryOps';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';

import { createTestAgent, mcpServices, type TestAgentContext } from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubLoopWithHooks } from '../loop/stubs';
import { stubToolResultTruncationService } from '../toolResultTruncation/stubs';
import { recordingWireLog, registerTestAgentWire } from '../../wire/stubs';

import { discoverTools, executeTool, fakeMcpClient } from './stubs';

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

  resolved(name: string): ResolvedServer | undefined {
    return this.resolvedEntries.get(name);
  }

  getRemoteServerUrl(name: string): string | undefined {
    return name === 'needs-auth' ? 'https://example.com/mcp' : undefined;
  }

  async reconnect(): Promise<void> {}

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

  disconnect(name: string): void {
    const current = this.entries.get(name);
    if (current === undefined) return;
    const entry: McpServerEntry = { ...current, status: 'disabled', toolCount: 0 };
    this.emit(entry);
    this.entries.delete(name);
  }

  private emit(entry: McpServerEntry): void {
    for (const listener of this.listeners) {
      listener(entry);
    }
  }
}

describe('AgentMcpService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let events: DomainEvent[];
  let telemetryEvents: TelemetryRecord[];
  let wire: IWireService;
  let wireRecordListeners: Set<(record: WireRecord) => void>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    events = [];
    telemetryEvents = [];
    wireRecordListeners = new Set();
    ix.stub(IEventBus, {
      publish: (event) => {
        events.push(event);
      },
      subscribe: () => toDisposable(() => {}),
    });
    ix.stub(ITelemetryService, recordingTelemetry(telemetryEvents));
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.set(IAgentToolExecutorService, new SyncDescriptor(AgentToolExecutorService));
    ix.stub(IAgentToolResultTruncationService, stubToolResultTruncationService());
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    wire = registerTestAgentWire(ix, 'mcp-test', {
      eventBus: ix.get(IEventBus),
      log: recordingWireLog([], (record) => {
        for (const listener of wireRecordListeners) listener(record);
      }),
    });
  });
  afterEach(() => {
    disposables.dispose();
  });

  function createService(manager: FakeMcpManager): AgentMcpService {
    ix.stub(ISessionMcpService, {
      ensureMcpReady: () => Promise.resolve(),
      connectionManager: () => manager as unknown as McpConnectionManager,
    });
    ix.stub(ISessionContext, { sessionDir: '/tmp/kimi-code-mcp-test' });
    const svc = ix.createInstance(AgentMcpService);
    disposables.add(svc);
    return svc;
  }

  it('delegates list / status events to the connection manager', async () => {
    const manager = new FakeMcpManager();
    manager.setResolved('s1', fakeMcpClient(), await discoverTools(fakeMcpClient()));
    manager.setResolved('s2', fakeMcpClient(), await discoverTools(fakeMcpClient()));
    const svc = createService(manager);

    const statuses: string[] = [];
    svc.onStatusChange((e) => statuses.push(`${e.name}:${e.status}`));

    manager.connect('s1');
    manager.connect('s2');
    expect(svc.list().map((e) => e.name).toSorted()).toEqual(['s1', 's2']);

    manager.disconnect('s1');
    expect(svc.list().map((e) => e.name)).toEqual(['s2']);
    expect(statuses).toEqual(['s1:connected', 's2:connected', 's1:disabled']);
  });

  it('resolves through the IAgentMcpService binding with no manager', () => {
    ix.set(IAgentMcpService, new SyncDescriptor(AgentMcpService));
    createService(new FakeMcpManager());
    const svc = ix.get(IAgentMcpService);
    expect(svc.list()).toEqual([]);
  });

  it('registers connected MCP tools under qualified names with source=mcp', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('local server', client, await discoverTools(client));
    createService(manager);

    manager.connect('local server');

    const infos = ix.get(IAgentToolRegistryService).list().filter((tool) => tool.source === 'mcp');
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

  it('respects the enabledNames filter when registering connected tools', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('s', client, await discoverTools(client), new Set(['echo']));
    createService(manager);

    manager.connect('s');

    const names = ix.get(IAgentToolRegistryService).list().filter((tool) => tool.source === 'mcp').map((tool) => tool.name);
    expect(names).toEqual(['mcp__s__echo']);
  });

  it('unregisters every tool when the server disconnects and emits mcp.disconnected', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);

    manager.connect('s');
    expect(ix.get(IAgentToolRegistryService).list().filter((tool) => tool.source === 'mcp')).toHaveLength(2);

    manager.disconnect('s');

    expect(ix.get(IAgentToolRegistryService).list().filter((tool) => tool.source === 'mcp')).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.list.updated',
        reason: 'mcp.disconnected',
        serverName: 's',
      }),
    );
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

    const names = ix.get(IAgentToolRegistryService).list().filter((tool) => tool.source === 'mcp').map((tool) => tool.name);
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

    expect(ix.get(IAgentToolRegistryService).list().filter((tool) => tool.source === 'mcp').map((tool) => tool.name)).toEqual([
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

    const names = ix.get(IAgentToolRegistryService).list().filter((tool) => tool.source === 'mcp').map((tool) => tool.name);
    expect(names).toEqual(['mcp__s__only']);
  });

  it('executing a wrapped MCP tool dispatches to client.callTool', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const echo = ix.get(IAgentToolRegistryService).resolve('mcp__s__echo');
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
    };
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const big = ix.get(IAgentToolRegistryService).resolve('mcp__s__big');
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
    };
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const snap = ix.get(IAgentToolRegistryService).resolve('mcp__s__snap');
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
    };
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const shot = ix.get(IAgentToolRegistryService).resolve('mcp__s__shot');
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
    };
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);
    manager.connect('s');

    const controller = new AbortController();
    const echo = ix.get(IAgentToolRegistryService).resolve('mcp__s__echo');
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

    const tools = ix.get(IAgentToolRegistryService).list();
    expect(tools).toEqual([
      expect.objectContaining({
        name: 'mcp__needs-auth__authenticate',
        source: 'mcp',
      }),
    ]);
  });

  it('emits tool.list.updated(mcp.failed) when a connected server fails', async () => {
    const manager = new FakeMcpManager();
    const client = fakeMcpClient();
    manager.setResolved('s', client, await discoverTools(client));
    createService(manager);

    manager.connect('s');
    manager.fail('s');

    expect(ix.get(IAgentToolRegistryService).list().filter((tool) => tool.source === 'mcp')).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.list.updated',
        reason: 'mcp.failed',
        serverName: 's',
      }),
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
    records: { type: string; [key: string]: unknown }[];
    off: { dispose(): void };
  } {
    const records: { type: string; [key: string]: unknown }[] = [];
    const listener = (record: WireRecord): void => {
      if (record.type === 'mcp.tools_discovered') {
        records.push(record as { type: string; [key: string]: unknown });
      }
    };
    wireRecordListeners.add(listener);
    return { records, off: toDisposable(() => wireRecordListeners.delete(listener)) };
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
      await wire.restore();
      await wire.flush();
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
      await wire.flush();
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
      await wire.restore();
      await wire.flush();
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
      await wire.restore();
      await wire.flush();

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
    await wire.restore();
    await wire.flush();

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
      await wire.flush();
      expect(records).toHaveLength(1);
      expect(records[0]!['collisions']).toHaveLength(1);

      manager.disconnect('graf.ana');
      manager.connect('graf_ana');
      await wire.flush();
      expect(records).toHaveLength(2);
      expect(records[1]!['collisions']).toBeUndefined();
    } finally {
      off.dispose();
    }
  });
});

describe('AgentMcpService + AgentProfileService', () => {
  let ctx: TestAgentContext;
  let manager: FakeMcpManager;
  let profile: IAgentProfileService;

  beforeEach(() => {
    manager = new FakeMcpManager();
    ctx = createTestAgent(mcpServices({ manager: manager as unknown as McpConnectionManager }));
    const mcp = ctx.get(IAgentMcpService);
    mcp.list();
    profile = ctx.get(IAgentProfileService);
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
    expect(
      ctx.toolsData()
        .filter((tool) => tool.source === 'mcp')
        .map((tool) => ({ name: tool.name, active: tool.active })),
    ).toEqual([
      { name: 'mcp__local__echo', active: false },
      { name: 'mcp__local__noop', active: false },
    ]);

    profile.update({ activeToolNames: ['Read', 'mcp__*'] });
    expect(
      ctx.toolsData()
        .filter((tool) => tool.source === 'mcp')
        .map((tool) => ({ name: tool.name, active: tool.active })),
    ).toEqual([
      { name: 'mcp__local__echo', active: true },
      { name: 'mcp__local__noop', active: true },
    ]);
  });

  it('supports server-scoped and exact MCP active-tool patterns', async () => {
    const githubClient = fakeMcpClient();
    const slackClient = fakeMcpClient();
    manager.setResolved('github', githubClient, await discoverTools(githubClient));
    manager.setResolved('slack', slackClient, await discoverTools(slackClient));
    manager.connect('github');
    manager.connect('slack');

    profile.update({ activeToolNames: ['mcp__github__*'] });
    expect(
      ctx.toolsData()
        .filter((tool) => tool.source === 'mcp' && tool.active)
        .map((tool) => tool.name)
      .toSorted(),
    ).toEqual(['mcp__github__echo', 'mcp__github__noop']);

    profile.update({ activeToolNames: ['mcp__slack__echo'] });
    expect(
      ctx.toolsData()
        .filter((tool) => tool.source === 'mcp' && tool.active)
        .map((tool) => tool.name),
    ).toEqual(['mcp__slack__echo']);
  });
});
