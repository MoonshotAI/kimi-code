import type { AgentEvent } from '@moonshot-ai/protocol';
import type { ContentPart, Tool as KosongTool } from '#/app/llmProtocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentEventSinkService } from '#/agent/eventSink';
import type { McpConnectionManager, McpServerEntry } from '#/agent/mcp/connection-manager';
import { IAgentMcpService, AgentMcpService } from '#/agent/mcp';
import type { McpOAuthService } from '#/agent/mcp/oauth';
import type { MCPClient } from '#/agent/mcp/types';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentTurnService } from '#/agent/turn';
import { IAgentProfileService } from '#/agent/profile';

import { createTestAgent, mcpServices, type TestAgentContext } from '../harness';
import { stubTurnWithHooks } from '../turn/stubs';
import { discoverTools, executeTool, fakeMcpClient } from './stubs';

const MCP_OUTPUT_TRUNCATED_TEXT =
  '\n\n[Output truncated: exceeded 100000 character limit. ' +
  'Use pagination or more specific queries to get remaining content.]';

interface ResolvedServer {
  readonly client: MCPClient;
  readonly tools: readonly KosongTool[];
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
  ): void {
    this.resolvedEntries.set(name, { client, tools, enabledNames });
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
  let events: AgentEvent[];

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    events = [];
    ix.stub(IAgentEventSinkService, {
      emit: (event) => {
        events.push(event);
      },
      on: () => toDisposable(() => {}),
    });
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.set(IAgentToolExecutorService, new SyncDescriptor(AgentToolExecutorService));
    ix.stub(IAgentTurnService, stubTurnWithHooks());
  });
  afterEach(() => {
    disposables.dispose();
  });

  function createService(manager: FakeMcpManager): AgentMcpService {
    const svc = ix.createInstance(
      AgentMcpService,
      { manager: manager as unknown as McpConnectionManager },
    );
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
    ix.set(IAgentMcpService, new SyncDescriptor(AgentMcpService, [{}]));
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
