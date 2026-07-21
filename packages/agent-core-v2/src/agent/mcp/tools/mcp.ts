/**
 * MCP tool adapter — wraps a remote MCP tool as an `ExecutableTool`.
 *
 * Each tool exposed by a connected MCP server is adapted into an
 * `ExecutableTool` whose `resolveExecution` forwards the call to the client
 * and normalizes the result. When the call throws because the transport
 * died (e.g. the stdio process exited), the adapter reconnects the server
 * through `options.reconnect` once and retries the call on the fresh
 * client, so a dropped connection surfaces as a slow call instead of a
 * failed turn.
 */

import type { Tool as KosongTool } from '#/app/llmProtocol/tool';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import { toErrorMessage } from '#/errors';
import { isAbortError } from '#/_base/utils/abort';

import type { ExecutableTool, ExecutableToolContext, ExecutableToolResult } from '#/tool/toolContract';
import { mcpResultToExecutableOutput } from '#/agent/mcp/output';
import type { MCPClient, MCPToolResult } from '#/agent/mcp/types';
import { isMcpConnectionClosedError } from '#/agent/mcp/client-shared';

interface McpToolOptions {
  readonly originalsDir?: string;
  readonly telemetry?: ITelemetryService;
  readonly isConnectionLost?: () => boolean;
  readonly reconnect?: (signal?: AbortSignal) => Promise<MCPClient | undefined>;
}

export function createMcpTool(
  qualifiedName: string,
  tool: KosongTool,
  client: MCPClient,
  options: McpToolOptions = {},
): ExecutableTool {
  const callTool = (activeClient: MCPClient, args: unknown, signal: AbortSignal) =>
    activeClient.callTool(tool.name, (args ?? {}) as Record<string, unknown>, signal);
  return {
    name: qualifiedName,
    description: tool.description,
    parameters: tool.parameters,
    resolveExecution: (args) => ({
      approvalRule: qualifiedName,
      execute: async (context) => {
        let result;
        try {
          result = await callTool(client, args, context.signal);
        } catch (error) {
          result = await retryAfterReconnect(error, args, context, options, callTool);
        }
        return normalizeMcpToolResult(
          await mcpResultToExecutableOutput(result, qualifiedName, {
            originalsDir: options.originalsDir,
            telemetry: options.telemetry,
          }),
        );
      },
    }),
  };
}

async function retryAfterReconnect(
  error: unknown,
  args: unknown,
  context: Pick<ExecutableToolContext, 'signal' | 'onUpdate'>,
  options: McpToolOptions,
  callTool: (client: MCPClient, args: unknown, signal: AbortSignal) => Promise<MCPToolResult>,
): Promise<MCPToolResult> {
  const reconnect = options.reconnect;
  if (
    reconnect === undefined ||
    options.isConnectionLost?.() !== true ||
    !isMcpConnectionClosedError(error) ||
    context.signal.aborted ||
    isAbortError(error)
  ) {
    throw error;
  }
  context.onUpdate?.({ kind: 'status', text: 'MCP connection lost — reconnecting…' });
  let freshClient: MCPClient | undefined;
  try {
    freshClient = await reconnect(context.signal);
  } catch (reconnectError) {
    if (context.signal.aborted || isAbortError(reconnectError)) {
      throw reconnectError;
    }
    throw new Error(
      `${toErrorMessage(error)} (reconnecting the MCP server also failed: ${toErrorMessage(reconnectError)})`,
      { cause: reconnectError },
    );
  }
  if (freshClient === undefined) {
    throw error;
  }
  return callTool(freshClient, args, context.signal);
}

function normalizeMcpToolResult(result: {
  readonly output: ExecutableToolResult['output'];
  readonly isError: boolean;
  readonly note?: string;
  readonly truncated?: true;
}): ExecutableToolResult {
  if (result.isError) {
    return result.truncated === true
      ? { output: result.output, isError: true, note: result.note, truncated: true }
      : { output: result.output, isError: true, note: result.note };
  }
  return result.truncated === true
    ? { output: result.output, note: result.note, truncated: true }
    : { output: result.output, note: result.note };
}
