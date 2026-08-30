import { createHash } from 'node:crypto';
import { defineState } from '#/state/state';
import type { Tool as KosongTool } from '#/kosong/contract/tool';

import { ErrorCodes, makeErrorPayload } from '#/errors';
import { abortable } from '#/_base/utils/abort';
import type { IAgentStateService } from '#/agent/state/agentState';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import { sessionMediaOriginalsDir } from '#/agent/media/image-originals';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { createMcpAuthTool } from '#/agent/mcp/tools/auth';
import { createMcpTool } from '#/agent/mcp/tools/mcp';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import type { McpServerEntry } from '#/mcpCore/connection-manager';
import { qualifyMcpToolName } from '#/mcpCore/tool-naming';
import type { MCPClient, MCPToolDefinition } from '#/mcpCore/types';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import {
  mcpDiscoveryKey,
  McpToolsDiscovered,
  type McpToolCollision,
} from '#/agent/mcp/mcpDiscoveryOps';
import { AgentErrorEvent } from '#/app/event/agentEvents';
import { McpServerStatus, ToolListUpdated } from '#/agent/mcp/mcpEvents';

import { setCatalogSource, type ToolCatalogState } from '#/actor/toolExecutor/internal/catalog';

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

export interface McpState {
  readonly tools: Map<string, McpToolRegistration>;
  readonly pendingDiscoveries: Array<() => void>;
}

export function createMcpState(): McpState {
  return { tools: new Map(), pendingDiscoveries: [] };
}

export interface McpDeps {
  readonly catalog: ToolCatalogState;
  readonly mcpHandle: ISessionMcpHandle;
  readonly sessionContext: ISessionContext;
  readonly dispatcher: IEventDispatcher;
  readonly telemetry: ITelemetryService;
  readonly scopeContext: IAgentScopeContext;
  readonly states: IAgentStateService;
}

export function mcpWaitForInitialLoad(deps: McpDeps, signal?: AbortSignal): Promise<void> {
  const ready = deps.mcpHandle.ready;
  return signal === undefined ? ready : abortable(ready, signal);
}

async function mcpReconnect(deps: McpDeps, name: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await deps.mcpHandle.connectionManager.reconnect(name);
  signal?.throwIfAborted();
}

function reconnectForToolCall(
  deps: McpDeps,
  serverName: string,
  staleClient: MCPClient,
  signal?: AbortSignal,
): Promise<MCPClient | undefined> {
  const work = joinHealedOrReconnect(deps, serverName, staleClient);
  return signal === undefined ? work : abortable(work, signal);
}

async function joinHealedOrReconnect(
  deps: McpDeps,
  serverName: string,
  staleClient: MCPClient,
): Promise<MCPClient | undefined> {
  const healed = deps.mcpHandle.connectionManager.resolved(serverName)?.client;
  if (healed !== undefined && healed !== staleClient) return healed;
  await deps.mcpHandle.connectionManager.reconnectAndJoin(serverName);
  const current = deps.mcpHandle.connectionManager.resolved(serverName)?.client;
  return current !== undefined && current !== staleClient ? current : undefined;
}

export function handleMcpServerStatusChange(
  state: McpState,
  deps: McpDeps,
  entry: McpServerEntry,
): void {
  if (!deps.mcpHandle.isBaselineServer(entry.name)) return;
  void deps.dispatcher.dispatch(
    new McpServerStatus({
      agentId: deps.scopeContext.agentId,
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
    registerConnectedMcpServer(state, deps, entry);
    return;
  }
  if (entry.status === 'needs-auth') {
    registerNeedsAuthMcpServer(state, deps, entry);
    return;
  }
  if (entry.status === 'failed' || entry.status === 'pending' || entry.status === 'removed') {
    return;
  }
  if (entry.status === 'disabled') {
    const removed = unregisterMcpServer(state, deps, entry.name);
    if (removed) {
      void deps.dispatcher.dispatch(
        new ToolListUpdated({
          agentId: deps.scopeContext.agentId,
          reason: 'mcp.disconnected',
          serverName: entry.name,
        }),
      );
    }
  }
}

function registerConnectedMcpServer(state: McpState, deps: McpDeps, entry: McpServerEntry): void {
  const resolved = deps.mcpHandle.connectionManager.resolved(entry.name);
  if (resolved === undefined) return;
  const result = registerMcpServer(
    state,
    deps,
    entry.name,
    resolved.client,
    resolved.tools,
    resolved.enabledNames,
  );
  emitMcpToolCollisions(deps, entry.name, result.collisions);
  recordDiscovery(state, deps, entry.name, resolved.rawTools, resolved.enabledNames, result.collisions);
  void deps.dispatcher.dispatch(
    new ToolListUpdated({
      agentId: deps.scopeContext.agentId,
      reason: 'mcp.connected',
      serverName: entry.name,
    }),
  );
}

function registerNeedsAuthMcpServer(state: McpState, deps: McpDeps, entry: McpServerEntry): void {
  unregisterMcpServer(state, deps, entry.name);
  const oauthService = deps.mcpHandle.connectionManager.oauthService;
  const serverUrl = deps.mcpHandle.connectionManager.getRemoteServerUrl(entry.name);
  if (oauthService === undefined || serverUrl === undefined) return;
  const tool = createMcpAuthTool({
    serverName: entry.name,
    serverUrl,
    oauthService,
    reconnect: (signal) => mcpReconnect(deps, entry.name, signal),
  });
  state.tools.set(tool.name, { tool, serverName: entry.name });
  deps.states.get(mcpMcpToolsByServerKey).set(entry.name, [tool.name]);
  syncCatalog(state, deps);
  void deps.dispatcher.dispatch(
    new ToolListUpdated({
      agentId: deps.scopeContext.agentId,
      reason: 'mcp.connected',
      serverName: entry.name,
    }),
  );
}

function registerMcpServer(
  state: McpState,
  deps: McpDeps,
  serverName: string,
  client: MCPClient,
  tools: readonly KosongTool[],
  enabledTools: ReadonlySet<string>,
): {
  readonly registered: readonly string[];
  readonly collisions: readonly McpToolCollision[];
} {
  unregisterMcpServer(state, deps, serverName);
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
    const existingEntry = state.tools.get(qualified);
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
      originalsDir: sessionMediaOriginalsDir(deps.sessionContext.sessionDir),
      telemetry: deps.telemetry,
      reconnect: (signal) => reconnectForToolCall(deps, serverName, client, signal),
      isRemoved: () => deps.mcpHandle.connectionManager.get(serverName)?.status === 'removed',
    });
    state.tools.set(qualified, { tool: executable, serverName });
    qualifiedNames.push(qualified);
  }
  deps.states.get(mcpMcpToolsByServerKey).set(serverName, qualifiedNames);
  syncCatalog(state, deps);
  return { registered: qualifiedNames, collisions };
}

function unregisterMcpServer(state: McpState, deps: McpDeps, serverName: string): boolean {
  const names = deps.states.get(mcpMcpToolsByServerKey).get(serverName);
  if (names === undefined) return false;
  for (const name of names) state.tools.delete(name);
  deps.states.get(mcpMcpToolsByServerKey).delete(serverName);
  syncCatalog(state, deps);
  return true;
}

function syncCatalog(state: McpState, deps: McpDeps): void {
  setCatalogSource(
    deps.catalog,
    state,
    [...state.tools.values()].map(({ tool }) => ({ tool, source: 'mcp' as const })),
  );
}

function recordDiscovery(
  state: McpState,
  deps: McpDeps,
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
    if (deps.states.get(mcpDiscoveryKey).seen.includes(key)) return;
    void deps.dispatcher.dispatch(
      new McpToolsDiscovered({
        agentId: deps.scopeContext.agentId,
        serverName,
        hash,
        tools: rawTools,
        enabledNames: enabledNamesSnapshot,
        collisions: collisions.length > 0 ? collisions : undefined,
      }),
    );
  };
  if (!deps.states.get(mcpDiscoveryWritesReadyKey)) {
    state.pendingDiscoveries.push(work);
    return;
  }
  work();
}

export function flushPendingMcpDiscoveries(state: McpState, deps: McpDeps): void {
  deps.states.set(mcpDiscoveryWritesReadyKey, true);
  const pending = state.pendingDiscoveries.splice(0);
  for (const work of pending) {
    work();
  }
}

function emitMcpToolCollisions(
  deps: McpDeps,
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
  void deps.dispatcher.dispatch(
    new AgentErrorEvent({
      ...makeErrorPayload(
        ErrorCodes.MCP_TOOL_NAME_COLLISION,
        `MCP server "${serverName}" registered ${collisions.length} tool name` +
          `${collisions.length === 1 ? '' : 's'} ` +
          `that collide with existing qualified names; the losing tools were dropped: ${summary}`,
        { details: { serverName, collisions: collisions as readonly unknown[] } },
      ),
      agentId: deps.scopeContext.agentId,
    }),
  );
}
