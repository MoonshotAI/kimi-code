import type { Tool as KosongTool } from '@moonshot-ai/kosong';

import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
  type IDisposable,
} from '../../../di';
import { ErrorCodes, makeErrorPayload } from '../../../errors';
import type { ExecutableToolResult } from '../../../loop';
import { createMcpAuthTool } from '../../../mcp/auth-tool';
import type { McpServerEntry } from '../../../mcp/connection-manager';
import { mcpResultToExecutableOutput } from '../../../mcp/output';
import { qualifyMcpToolName } from '../../../mcp/tool-naming';
import type { MCPClient } from '../../../mcp/types';
import { IEventBus } from '../eventBus/eventBus';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import type { Tool } from '../types';
import { IMcpRuntimeService, type McpRuntimeServiceOptions } from './mcpRuntime';

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

export class McpRuntimeService extends Disposable implements IMcpRuntimeService {
  private readonly mcpTools = new Map<string, McpToolRegistration>();
  private readonly mcpToolsByServer = new Map<string, string[]>();

  constructor(
    private readonly options: McpRuntimeServiceOptions = {},
    @IToolRegistry private readonly registry: IToolRegistry,
    @IEventBus private readonly events: IEventBus,
  ) {
    super();
    this.attachMcpTools();
  }

  get oauthService() {
    return this.options.manager?.oauthService;
  }

  waitForInitialLoad(signal?: AbortSignal): Promise<void> {
    return this.options.manager?.waitForInitialLoad(signal) ?? Promise.resolve();
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

  onStatusChange(listener: Parameters<IMcpRuntimeService['onStatusChange']>[0]) {
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
    this.events.emit({
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
      this.events.emit({
        type: 'tool.list.updated',
        reason: 'mcp.failed',
        serverName: entry.name,
      });
      return;
    }
    if (entry.status === 'disabled' || entry.status === 'pending') {
      const removed = this.unregisterMcpServer(entry.name);
      if (removed) {
        this.events.emit({
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
    this.events.emit({
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
    this.events.emit({
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
        this.registry.register(this.createMcpTool(qualified, tool, client), {
          source: 'mcp',
        }),
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

  private createMcpTool(
    qualifiedName: string,
    tool: KosongTool,
    client: MCPClient,
  ): Tool {
    return {
      name: qualifiedName,
      description: tool.description,
      parameters: tool.parameters,
      resolveExecution: (args) => ({
        approvalRule: qualifiedName,
        execute: async (context) => {
          const result = await client.callTool(
            tool.name,
            (args ?? {}) as Record<string, unknown>,
            context.signal,
          );
          return normalizeMcpToolResult(mcpResultToExecutableOutput(result, qualifiedName));
        },
      }),
    };
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
    this.events.emit({
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

function normalizeMcpToolResult(result: {
  readonly output: ExecutableToolResult['output'];
  readonly isError: boolean;
}): ExecutableToolResult {
  if (result.isError) return { output: result.output, isError: true };
  return { output: result.output };
}

registerSingleton(IMcpRuntimeService, new SyncDescriptor(McpRuntimeService, [{}], true));
