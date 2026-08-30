import { createHash } from 'node:crypto';
import { defineState } from '#/state/state';
import type { Tool as KosongTool } from '#/kosong/contract/tool';

import { Disposable } from '#/_base/di/lifecycle';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';
import type { ToolCatalog } from '#/actor/toolExecutor/internal/catalog';
import type { ToolExecutorPipeline } from '#/actor/toolExecutor/internal/executor';
import { ErrorCodes, makeErrorPayload } from "#/errors";
import { abortable } from '#/_base/utils/abort';
import { IAgentStateService } from '#/agent/state/agentState';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { sessionMediaOriginalsDir } from '#/agent/media/image-originals';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { createMcpAuthTool } from '#/agent/mcp/tools/auth';
import { createMcpTool } from '#/agent/mcp/tools/mcp';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentHostService } from '#/agent/host/agentHost';
import { getLoopControl } from '#/actor/loop/internal/access';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import type { McpServerEntry } from '#/mcpCore/connection-manager';
import { qualifyMcpToolName } from '#/mcpCore/tool-naming';
import type { MCPClient, MCPToolDefinition } from '#/mcpCore/types';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  mcpDiscoveryKey,
  McpToolsDiscovered,
  type McpToolCollision,
} from '#/agent/mcp/mcpDiscoveryOps';
import { AgentErrorEvent } from '#/app/event/agentEvents';
import { McpServerStatus, ToolListUpdated } from '#/agent/mcp/mcpEvents';

interface McpToolRegistration {
  readonly tool: import('#/tool/toolContract').ExecutableTool;
  readonly serverName: string;
}

export const mcpMcpToolsByServerKey = defineState<Map<string, string[]>>(
  'mcp.mcpToolsByServer',
  () => new Map(),
);
export const mcpDiscoveryWritesReadyKey = defineState<boolean>(
  'mcp.discoveryWritesReady',
  () => false,
);

export class McpToolProvider extends Disposable {
  private readonly mcpTools = new Map<string, McpToolRegistration>();
  private readonly pendingDiscoveries: Array<() => void> = [];
  private readonly mcpHandle: ISessionMcpHandle;
  private readonly sessionContext: ISessionContext;
  private readonly dispatcher: IEventDispatcher;
  private readonly telemetry: ITelemetryService;
  private readonly scopeContext: IAgentScopeContext;
  private readonly states: IAgentStateService;

  constructor(
    runtime: AgentRuntimeContext<unknown>,
    private readonly catalog: ToolCatalog,
    pipeline: ToolExecutorPipeline,
  ) {
    super();
    this.mcpHandle = runtime.get(ISessionMcpHandle);
    this.sessionContext = runtime.get(ISessionContext);
    const host = runtime.get(IAgentHostService).of(runtime.agent);
    this.dispatcher = host.dispatcher;
    this.telemetry = host.telemetry;
    this.scopeContext = host.scopeContext;
    this.states = host.state;
    const loop = getLoopControl(runtime.agent);
    this.states.contributeState(mcpDiscoveryKey);
    this.states.contributeState(mcpMcpToolsByServerKey);
    this.states.contributeState(mcpDiscoveryWritesReadyKey);
    this.attachMcpTools();
    loop.hooks.onWillBeginStep.register('mcp', async (ctx, next) => {
      await this.waitForInitialLoad(ctx.signal);
      await next();
    });
    this._register(
      pipeline.onWillExecute((event) => {
        event.waitUntil(this.waitForInitialLoad(event.signal));
      }),
    );
    this._register(
      this.dispatcher.hooks.onDidRestore.register('mcp', async (_ctx, next) => {
        this.flushPendingDiscoveries();
        await next();
      }),
    );
  }

  private get mcpToolsByServer(): Map<string, string[]> {
    return this.states.get(mcpMcpToolsByServerKey);
  }

  private get discoveryWritesReady(): boolean {
    return this.states.get(mcpDiscoveryWritesReadyKey);
  }

  private set discoveryWritesReady(value: boolean) {
    this.states.set(mcpDiscoveryWritesReadyKey, value);
  }

  get oauthService() {
    return this.mcpHandle.connectionManager.oauthService;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    const ready = this.mcpHandle.ready;
    return signal === undefined ? ready : abortable(ready, signal);
  }

  initialLoadDurationMs(): number {
    return this.mcpHandle.connectionManager.initialLoadDurationMs();
  }

  list() {
    return this.mcpHandle.connectionManager.list();
  }

  resolved(name: string) {
    return this.mcpHandle.connectionManager.resolved(name);
  }

  getRemoteServerUrl(name: string) {
    return this.mcpHandle.connectionManager.getRemoteServerUrl(name);
  }

  async reconnect(name: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.mcpHandle.connectionManager.reconnect(name);
    signal?.throwIfAborted();
  }

  private reconnectForToolCall(
    serverName: string,
    staleClient: MCPClient,
    signal?: AbortSignal,
  ): Promise<MCPClient | undefined> {
    const work = this.joinHealedOrReconnect(serverName, staleClient);
    return signal === undefined ? work : abortable(work, signal);
  }

  private async joinHealedOrReconnect(
    serverName: string,
    staleClient: MCPClient,
  ): Promise<MCPClient | undefined> {
    const healed = this.resolved(serverName)?.client;
    if (healed !== undefined && healed !== staleClient) return healed;
    await this.mcpHandle.connectionManager.reconnectAndJoin(serverName);
    const current = this.resolved(serverName)?.client;
    return current !== undefined && current !== staleClient ? current : undefined;
  }

  onStatusChange(listener: (entry: McpServerEntry) => void) {
    const unsubscribe = this.mcpHandle.connectionManager.onStatusChange(listener);
    return {
      dispose: unsubscribe,
    };
  }

  private attachMcpTools(): void {
    for (const entry of this.list()) {
      this.handleMcpServerStatusChange(entry);
    }
    this._register(
      this.onStatusChange((entry) => {
        this.handleMcpServerStatusChange(entry);
      }),
    );
  }

  private handleMcpServerStatusChange(entry: McpServerEntry): void {
    if (!this.mcpHandle.isBaselineServer(entry.name)) return;
    void this.dispatcher.dispatch(
      new McpServerStatus({
        agentId: this.scopeContext.agentId,
        server: {
          name: entry.name,
          transport: entry.transport,
          status: entry.status,
          toolCount: entry.toolCount,
          error: entry.error,
        },
      }),
    );
    if (entry.status === 'connected') {
      this.registerConnectedMcpServer(entry);
      return;
    }
    if (entry.status === 'needs-auth') {
      this.registerNeedsAuthMcpServer(entry);
      return;
    }
    if (entry.status === 'failed' || entry.status === 'pending' || entry.status === 'removed') {
      return;
    }
    if (entry.status === 'disabled') {
      const removed = this.unregisterMcpServer(entry.name);
      if (removed) {
        void this.dispatcher.dispatch(
          new ToolListUpdated({
            agentId: this.scopeContext.agentId,
            reason: 'mcp.disconnected',
            serverName: entry.name,
          }),
        );
      }
    }
  }

  private registerConnectedMcpServer(entry: McpServerEntry): void {
    const resolved = this.resolved(entry.name);
    if (resolved === undefined) return;
    const result = this.registerMcpServer(
      entry.name,
      resolved.client,
      resolved.tools,
      resolved.enabledNames,
    );
    this.emitMcpToolCollisions(entry.name, result.collisions);
    this.recordDiscovery(entry.name, resolved.rawTools, resolved.enabledNames, result.collisions);
    void this.dispatcher.dispatch(
      new ToolListUpdated({
        agentId: this.scopeContext.agentId,
        reason: 'mcp.connected',
        serverName: entry.name,
      }),
    );
  }

  private registerNeedsAuthMcpServer(entry: McpServerEntry): void {
    this.unregisterMcpServer(entry.name);
    const oauthService = this.oauthService;
    const serverUrl = this.getRemoteServerUrl(entry.name);
    if (oauthService === undefined || serverUrl === undefined) return;
    const tool = createMcpAuthTool({
      serverName: entry.name,
      serverUrl,
      oauthService,
      reconnect: (signal) => this.reconnect(entry.name, signal),
    });
    this.mcpTools.set(tool.name, { tool, serverName: entry.name });
    this.mcpToolsByServer.set(entry.name, [tool.name]);
    this.syncCatalog();
    void this.dispatcher.dispatch(
      new ToolListUpdated({
        agentId: this.scopeContext.agentId,
        reason: 'mcp.connected',
        serverName: entry.name,
      }),
    );
  }

  private registerMcpServer(
    serverName: string,
    client: MCPClient,
    tools: readonly KosongTool[],
    enabledTools: ReadonlySet<string>,
  ): {
    readonly registered: readonly string[];
    readonly collisions: readonly McpToolCollision[];
  } {
    this.unregisterMcpServer(serverName);
    const qualifiedNames: string[] = [];
    const collisions: McpToolCollision[] = [];
    const seenInThisCall = new Map<string, string>();
    for (const tool of tools) {
      if (!enabledTools.has(tool.name)) continue;
      const qualified = qualifyMcpToolName(serverName, tool.name);
      const firstInThisCall = seenInThisCall.get(qualified);
      if (firstInThisCall !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'same_server', toolName: firstInThisCall },
        });
        continue;
      }
      const existingEntry = this.mcpTools.get(qualified);
      if (existingEntry !== undefined) {
        collisions.push({
          qualified,
          toolName: tool.name,
          collidesWith: { kind: 'other_server', serverName: existingEntry.serverName },
        });
        continue;
      }
      seenInThisCall.set(qualified, tool.name);
      const executable = createMcpTool(qualified, tool, client, {
        originalsDir: sessionMediaOriginalsDir(this.sessionContext.sessionDir),
        telemetry: this.telemetry,
        reconnect: (signal) => this.reconnectForToolCall(serverName, client, signal),
        isRemoved: () => this.mcpHandle.connectionManager.get(serverName)?.status === 'removed',
      });
      this.mcpTools.set(qualified, { tool: executable, serverName });
      qualifiedNames.push(qualified);
    }
    this.mcpToolsByServer.set(serverName, qualifiedNames);
    this.syncCatalog();
    return { registered: qualifiedNames, collisions };
  }

  private unregisterMcpServer(serverName: string): boolean {
    const names = this.mcpToolsByServer.get(serverName);
    if (names === undefined) return false;
    for (const name of names) this.mcpTools.delete(name);
    this.mcpToolsByServer.delete(serverName);
    this.syncCatalog();
    return true;
  }

  private syncCatalog(): void {
    this.catalog.setSource(
      this,
      [...this.mcpTools.values()].map(({ tool }) => ({ tool, source: 'mcp' as const })),
    );
  }

  private recordDiscovery(
    serverName: string,
    rawTools: readonly MCPToolDefinition[],
    enabledNames: ReadonlySet<string>,
    collisions: readonly McpToolCollision[],
  ): void {
    const enabledNamesSnapshot = [...enabledNames].toSorted((a, b) => a.localeCompare(b));
    const work = (): void => {
      const hash = createHash('sha256')
        .update(JSON.stringify({ tools: rawTools, enabledNames: enabledNamesSnapshot, collisions }))
        .digest('hex');
      const key = `${serverName}\n${hash}`;
      if (this.states.get(mcpDiscoveryKey).seen.includes(key)) return;
      void this.dispatcher.dispatch(
        new McpToolsDiscovered({
          agentId: this.scopeContext.agentId,
          serverName,
          hash,
          tools: rawTools,
          enabledNames: enabledNamesSnapshot,
          collisions: collisions.length > 0 ? collisions : undefined,
        }),
      );
    };
    if (!this.discoveryWritesReady) {
      this.pendingDiscoveries.push(work);
      return;
    }
    work();
  }

  private flushPendingDiscoveries(): void {
    this.discoveryWritesReady = true;
    const pending = this.pendingDiscoveries.splice(0);
    for (const work of pending) {
      work();
    }
  }

  private emitMcpToolCollisions(
    serverName: string,
    collisions: readonly McpToolCollision[],
  ): void {
    if (collisions.length === 0) return;
    const summary = collisions
      .map((collision) =>
        collision.collidesWith.kind === 'same_server'
          ? `"${collision.toolName}" -> ${collision.qualified} (collides with "${collision.collidesWith.toolName}" from the same server)`
          : `"${collision.toolName}" -> ${collision.qualified} (collides with server "${collision.collidesWith.serverName}")`,
      )
      .join('; ');
    void this.dispatcher.dispatch(
      new AgentErrorEvent({
        ...makeErrorPayload(
          ErrorCodes.MCP_TOOL_NAME_COLLISION,
          `MCP server "${serverName}" registered ${collisions.length} tool name` +
            `${collisions.length === 1 ? '' : 's'} ` +
            `that collide with existing qualified names; the losing tools were dropped: ${summary}`,
          { details: { serverName, collisions: collisions as readonly unknown[] } },
        ),
        agentId: this.scopeContext.agentId,
      }),
    );
  }
}

