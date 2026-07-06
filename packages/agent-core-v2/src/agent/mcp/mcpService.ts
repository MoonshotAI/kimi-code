import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { Tool as KosongTool } from '#/app/llmProtocol';

import {
  Disposable,
  type IDisposable,
} from "#/_base/di";
import { ErrorCodes, makeErrorPayload } from "#/errors";
import type {
  ErrorEvent,
  McpServerStatusEvent,
  ToolListUpdatedEvent,
} from '@moonshot-ai/protocol';
import { IEventBus } from '#/app/event';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { createMcpAuthTool } from '#/agent/mcp/tools/auth';
import { createMcpTool } from '#/agent/mcp/tools/mcp';
import type { McpServerEntry } from './connection-manager';
import { IAgentMcpService, type McpServiceOptions } from './mcp';
import { qualifyMcpToolName } from './tool-naming';
import type { MCPClient } from './types';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'mcp.server.status': Omit<McpServerStatusEvent, 'type'>;
    'tool.list.updated': Omit<ToolListUpdatedEvent, 'type'>;
    // Canonical home of the shared `error` event (`IEventBus`); other domains
    // (`turn`, `fullCompaction`) reuse it via interface-merge, not re-declared.
    error: Omit<ErrorEvent, 'type'>;
  }
}

interface McpToolRegistration {
  readonly disposable: IDisposable;
  readonly serverName: string;
}

interface McpToolCollision {
  readonly qualified: string;
  readonly toolName: string;
  readonly collidesWith:
    | { readonly kind: 'same_server'; readonly toolName: string }
    | { readonly kind: 'other_server'; readonly serverName: string };
}

export class AgentMcpService extends Disposable implements IAgentMcpService {
  declare readonly _serviceBrand: undefined;
  private readonly mcpTools = new Map<string, McpToolRegistration>();
  private readonly mcpToolsByServer = new Map<string, string[]>();

  constructor(
    private readonly options: McpServiceOptions = {},
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    this.attachMcpTools();
    this._register(
      toolExecutor.hooks.onWillExecuteTool.register(
        'mcp-wait-for-initial-load',
        async (ctx, next) => {
          await this.waitForInitialLoad(ctx.signal);
          await next();
        },
      ),
    );
  }

  get oauthService() {
    return this.options.manager?.oauthService;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    return this.options.manager?.waitForInitialLoad(signal) ?? Promise.resolve();
  }

  initialLoadDurationMs(): number {
    return this.options.manager?.initialLoadDurationMs() ?? 0;
  }

  list() {
    return this.options.manager?.list() ?? [];
  }

  resolved(name: string) {
    return this.options.manager?.resolved(name);
  }

  getRemoteServerUrl(name: string) {
    return this.options.manager?.getRemoteServerUrl(name);
  }

  async reconnect(name: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.options.manager?.reconnect(name);
    signal?.throwIfAborted();
  }

  onStatusChange(listener: Parameters<IAgentMcpService['onStatusChange']>[0]) {
    const unsubscribe = this.options.manager?.onStatusChange(listener);
    return {
      dispose: unsubscribe ?? (() => undefined),
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
          createMcpTool(qualified, tool, client, { originalsDir: this.options.originalsDir }),
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
  InstantiationType.Delayed,
  'mcp',
);
