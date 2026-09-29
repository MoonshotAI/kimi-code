import { isAbortError, type MediaStore, type ToolDefinition } from '@moonshot-ai/agent-core';

import {
  abortable,
  isMcpConnectionClosedError,
  isMcpMalformedResultError,
  isMcpTransportFailure,
  probeMcpLiveness,
  type MCPClient,
  type MCPToolResult,
} from '#/features/mcp/core/client-shared';
import { mcpResultToToolResult } from '#/features/mcp/core/output';
import { qualifyMcpToolName } from '#/features/mcp/core/tool-naming';

export interface McpToolCollision {
  readonly qualified: string;
  readonly toolName: string;
  readonly collidesWith:
    | { readonly kind: 'same_server'; readonly toolName: string }
    | { readonly kind: 'other_server'; readonly serverName: string };
}

export interface PlannedMcpToolName {
  readonly qualified: string;
  readonly toolName: string;
}

export function planMcpToolRegistrations(
  serverName: string,
  toolNames: readonly string[],
  enabledNames: ReadonlySet<string>,
  ownerOf: (qualified: string) => string | undefined,
): { readonly planned: PlannedMcpToolName[]; readonly collisions: McpToolCollision[] } {
  const planned: PlannedMcpToolName[] = [];
  const collisions: McpToolCollision[] = [];
  const seenInThisCall = new Map<string, string>();
  for (const toolName of toolNames) {
    if (!enabledNames.has(toolName)) continue;
    const qualified = qualifyMcpToolName(serverName, toolName);
    const firstInThisCall = seenInThisCall.get(qualified);
    if (firstInThisCall !== undefined) {
      collisions.push({
        qualified,
        toolName,
        collidesWith: { kind: 'same_server', toolName: firstInThisCall },
      });
      continue;
    }
    const otherServer = ownerOf(qualified);
    if (otherServer !== undefined) {
      collisions.push({
        qualified,
        toolName,
        collidesWith: { kind: 'other_server', serverName: otherServer },
      });
      continue;
    }
    seenInThisCall.set(qualified, toolName);
    planned.push({ qualified, toolName });
  }
  return { planned, collisions };
}

export interface McpMirroredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface CreateMcpToolOptions {
  readonly mediaStore?: MediaStore;
  readonly providerType?: () => string | undefined;
  readonly reconnect?: (signal?: AbortSignal) => Promise<MCPClient | undefined>;
  readonly isRemoved?: () => boolean;
  readonly deferred?: boolean;
}

export function createMcpTool(
  qualifiedName: string,
  tool: McpMirroredTool,
  client: MCPClient,
  options: CreateMcpToolOptions = {},
): ToolDefinition {
  const callTool = (activeClient: MCPClient, args: unknown, signal: AbortSignal) =>
    activeClient.callTool(tool.name, (args ?? {}) as Record<string, unknown>, signal);
  return {
    name: qualifiedName,
    description: tool.description,
    parameters: tool.parameters,
    deferred: options.deferred === true ? true : undefined,
    execute: async ({ toolCall, signal, onUpdate }) => {
      if (options.isRemoved?.() === true) {
        return {
          content: [
            {
              type: 'text',
              text:
                `MCP server for tool "${qualifiedName}" has been removed ` +
                `(plugin uninstalled or config deleted). Do not call this tool again.`,
            },
          ],
          isError: true,
        };
      }
      const args: unknown = toolCall.arguments === null ? {} : JSON.parse(toolCall.arguments);
      let result: MCPToolResult;
      try {
        result = await callTool(client, args, signal);
      } catch (error) {
        result = await retryAfterReconnect(error, client, args, { signal, onUpdate }, options, callTool);
      }
      return mcpResultToToolResult(result, qualifiedName, {
        signal,
        mediaStore: options.mediaStore,
        providerType: options.providerType?.(),
      });
    },
  };
}

async function retryAfterReconnect(
  error: unknown,
  client: MCPClient,
  args: unknown,
  context: {
    readonly signal: AbortSignal;
    readonly onUpdate?: (update: { key: string; text: string; percent?: number }) => void;
  },
  options: CreateMcpToolOptions,
  callTool: (client: MCPClient, args: unknown, signal: AbortSignal) => Promise<MCPToolResult>,
): Promise<MCPToolResult> {
  const reconnect = options.reconnect;
  const isUnrecoverable = (e: unknown): boolean =>
    context.signal.aborted ||
    isAbortError(e) ||
    !isMcpTransportFailure(e) ||
    isMcpMalformedResultError(e);
  if (reconnect === undefined || isUnrecoverable(error)) {
    throw error;
  }

  let failure = error;
  if (!isMcpConnectionClosedError(failure)) {
    const alive = await probeMcpLiveness(client, context.signal);
    context.signal.throwIfAborted();
    if (alive) {
      try {
        return await callTool(client, args, context.signal);
      } catch (retryError) {
        if (isUnrecoverable(retryError)) {
          throw retryError;
        }
        failure = retryError;
      }
    }
  }

  context.onUpdate?.({ key: 'status', text: 'MCP connection lost — reconnecting…' });
  let freshClient: MCPClient | undefined;
  try {
    freshClient = await reconnect(context.signal);
  } catch (reconnectError) {
    if (context.signal.aborted || isAbortError(reconnectError)) {
      throw reconnectError;
    }
    const failureMessage = failure instanceof Error ? failure.message : String(failure);
    const reconnectMessage =
      reconnectError instanceof Error ? reconnectError.message : String(reconnectError);
    throw new Error(
      `${failureMessage} (reconnecting the MCP server also failed: ${reconnectMessage})`,
      { cause: reconnectError },
    );
  }
  if (freshClient === undefined) {
    throw failure;
  }
  return callTool(freshClient, args, context.signal);
}

export function reconnectForServer(
  manager: {
    resolved(name: string): { readonly client: MCPClient } | undefined;
    reconnectAndJoin(name: string): Promise<void>;
  },
  serverName: string,
  staleClient: MCPClient,
  signal?: AbortSignal,
): Promise<MCPClient | undefined> {
  const work = joinHealedOrReconnect(manager, serverName, staleClient);
  return signal === undefined ? work : abortable(work, signal);
}

async function joinHealedOrReconnect(
  manager: {
    resolved(name: string): { readonly client: MCPClient } | undefined;
    reconnectAndJoin(name: string): Promise<void>;
  },
  serverName: string,
  staleClient: MCPClient,
): Promise<MCPClient | undefined> {
  const healed = manager.resolved(serverName)?.client;
  if (healed !== undefined && healed !== staleClient) return healed;
  await manager.reconnectAndJoin(serverName);
  const current = manager.resolved(serverName)?.client;
  return current !== undefined && current !== staleClient ? current : undefined;
}
