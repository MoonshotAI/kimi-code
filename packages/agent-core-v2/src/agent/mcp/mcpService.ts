import { createHash } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { Tool as KosongTool } from '#/kosong/contract/tool';

import { Disposable, type IDisposable } from "#/_base/di/lifecycle";
import type { KimiErrorPayload } from '#/_base/errors/serialize';
import { ErrorCodes, makeErrorPayload } from "#/errors";
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { sessionMediaOriginalsDir } from '#/agent/media/image-originals';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { createMcpAuthTool } from '#/agent/mcp/tools/auth';
import { createMcpTool } from '#/agent/mcp/tools/mcp';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import type { McpServerEntry } from './connection-manager';
import { IAgentMcpService } from './mcp';
import { qualifyMcpToolName } from './tool-naming';
import type { MCPClient, MCPToolDefinition } from './types';
import { IWireService } from '#/wire/wire';
import {
  McpDiscoveryModel,
  mcpToolsDiscovered,
  type McpToolCollision,
} from './mcpDiscoveryOps';

export interface ErrorEvent extends KimiErrorPayload {
  readonly type: 'error';
}

export interface McpServerStatusPayload {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  readonly toolCount: number;
  readonly error?: string;
}

export interface McpServerStatusEvent {
  readonly type: 'mcp.server.status';
  readonly server: McpServerStatusPayload;
}

export type ToolListUpdatedReason = 'mcp.connected' | 'mcp.disconnected' | 'mcp.failed';

export interface ToolListUpdatedEvent {
  readonly type: 'tool.list.updated';
  readonly reason: ToolListUpdatedReason;
  readonly serverName: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'mcp.server.status': McpServerStatusEvent;
    'tool.list.updated': ToolListUpdatedEvent;
    error: ErrorEvent;
  }
}

interface McpToolRegistration {
  readonly disposable: IDisposable;
  readonly serverName: string;
}

export class AgentMcpService extends Disposable implements IAgentMcpService {
  declare readonly _serviceBrand: undefined;
  private readonly mcpTools = new Map<string, McpToolRegistration>();
  private readonly mcpToolsByServer = new Map<string, string[]>();
  private readonly pendingDiscoveries: Array<() => void> = [];
  private discoveryWritesReady = false;

  constructor(
    @ISessionMcpService private readonly sessionMcp: ISessionMcpService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IWireService private readonly wire: IWireService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this.attachMcpTools();
    this._register(
      toolExecutor.hooks.onBeforeExecuteTool.register(
        'mcp-wait-for-initial-load',
        async (ctx, next) => {
          await this.waitForInitialLoad(ctx.signal);
          await next();
        },
      ),
    );
    this._register(
      this.wire.hooks.onDidRestore.register('mcp', async (_ctx, next) => {
        this.flushPendingDiscoveries();
        await next();
      }),
    );
  }

  get oauthService() {
    return this.sessionMcp.connectionManager().oauthService;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    return this.sessionMcp.connectionManager().waitForInitialLoad(signal);
  }

  initialLoadDurationMs(): number {
    return this.sessionMcp.connectionManager().initialLoadDurationMs();
  }

  list() {
    return this.sessionMcp.connectionManager().list();
  }

  resolved(name: string) {
    return this.sessionMcp.connectionManager().resolved(name);
  }

  getRemoteServerUrl(name: string) {
    return this.sessionMcp.connectionManager().getRemoteServerUrl(name);
  }

  async reconnect(name: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.sessionMcp.connectionManager().reconnect(name);
    signal?.throwIfAborted();
  }

  onStatusChange(listener: Parameters<IAgentMcpService['onStatusChange']>[0]) {
    const unsubscribe = this.sessionMcp.connectionManager().onStatusChange(listener);
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
    this.eventBus.publish({
      type: 'mcp.server.status',
      server: {
        name: entry.name,
        transport: entry.transport,
        status: entry.status,
        toolCount: entry.toolCount,
        error: entry.error,
      },
    });
    if (entry.status === 'connected') {
      this.registerConnectedMcpServer(entry);
      return;
    }
    if (entry.status === 'needs-auth') {
      this.registerNeedsAuthMcpServer(entry);
      return;
    }
    if (entry.status === 'failed') {
      this.unregisterMcpServer(entry.name);
      this.eventBus.publish({
        type: 'tool.list.updated',
        reason: 'mcp.failed',
        serverName: entry.name,
      });
      return;
    }
    if (entry.status === 'disabled' || entry.status === 'pending') {
      const removed = this.unregisterMcpServer(entry.name);
      if (removed) {
        this.eventBus.publish({
          type: 'tool.list.updated',
          reason: 'mcp.disconnected',
          serverName: entry.name,
        });
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
    this.eventBus.publish({
      type: 'tool.list.updated',
      reason: 'mcp.connected',
      serverName: entry.name,
    });
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
    const disposable = this._register(this.registry.register(tool, { source: 'mcp' }));
    this.mcpTools.set(tool.name, { disposable, serverName: entry.name });
    this.mcpToolsByServer.set(entry.name, [tool.name]);
    this.eventBus.publish({
      type: 'tool.list.updated',
      reason: 'mcp.connected',
      serverName: entry.name,
    });
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
      const disposable = this._register(
        this.registry.register(
          createMcpTool(qualified, tool, client, {
            originalsDir: sessionMediaOriginalsDir(this.sessionContext.sessionDir),
            telemetry: this.telemetry,
          }),
          { source: 'mcp' },
        ),
      );
      this.mcpTools.set(qualified, { disposable, serverName });
      qualifiedNames.push(qualified);
    }
    this.mcpToolsByServer.set(serverName, qualifiedNames);
    return { registered: qualifiedNames, collisions };
  }

  private unregisterMcpServer(serverName: string): boolean {
    const names = this.mcpToolsByServer.get(serverName);
    if (names === undefined) return false;
    for (const name of names) {
      const entry = this.mcpTools.get(name);
      entry?.disposable.dispose();
      this.mcpTools.delete(name);
    }
    this.mcpToolsByServer.delete(serverName);
    return true;
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
      if (this.wire.getModel(McpDiscoveryModel).seen.includes(key)) return;
      this.wire.dispatch(
        mcpToolsDiscovered({
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
    this.eventBus.publish({
      type: 'error',
      ...makeErrorPayload(
        ErrorCodes.MCP_TOOL_NAME_COLLISION,
        `MCP server "${serverName}" registered ${collisions.length} tool name` +
          `${collisions.length === 1 ? '' : 's'} ` +
          `that collide with existing qualified names; the losing tools were dropped: ${summary}`,
        { details: { serverName, collisions: collisions as readonly unknown[] } },
      ),
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMcpService,
  AgentMcpService,
  InstantiationType.Eager,
  'mcp',
);
