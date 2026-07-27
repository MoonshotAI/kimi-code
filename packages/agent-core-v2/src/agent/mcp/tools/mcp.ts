/**
 * MCP tool adapter — wraps a remote MCP tool as an `ExecutableTool`.
 *
 * Each tool exposed by a connected MCP server is adapted into an
 * `ExecutableTool` whose `resolveExecution` forwards the call to the client
 * and normalizes the result. When a call fails, the adapter picks one of
 * three recoveries based on why it failed:
 *
 * - The server answered (a JSON-RPC error, or a response that failed
 *   client-side schema validation) → the error is rethrown; reconnecting
 *   would not change the answer.
 * - The failure is ambiguous (a raw fetch/socket error) → the client is
 *   probed with a ping: alive means a transient blip and the call is
 *   retried once in place; dead means the transport is gone.
 * - The transport is provably dead (the SDK fired `onclose`, or the probe
 *   failed) → the server is reconnected once through `options.reconnect`
 *   and the call retried on the fresh client, so a dropped connection
 *   surfaces as a slow call instead of a failed turn.
 *
 * Retries are at-least-once: if the transport died after the server
 * processed the call but before the response arrived, the retry may
 * duplicate side effects. There is no protocol-level dedup across
 * reconnects, so this trade-off is accepted deliberately.
 */

import type { Tool as KosongTool } from '#/kosong/contract/tool';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import { toErrorMessage } from '#/errors';
import { isAbortError } from '#/_base/utils/abort';

import type { ExecutableTool, ExecutableToolContext, ExecutableToolResult } from '#/tool/toolContract';
import { mcpResultToExecutableOutput } from '#/agent/mcp/output';
import type { MCPClient, MCPToolResult } from '#/agent/mcp/types';
import {
  isMcpConnectionClosedError,
  isMcpMalformedResultError,
  isMcpTransportFailure,
  probeMcpLiveness,
} from '#/agent/mcp/client-shared';

interface McpToolOptions {
  readonly originalsDir?: string;
  readonly telemetry?: ITelemetryService;
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
          result = await retryAfterReconnect(error, client, args, context, options, callTool);
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
  client: MCPClient,
  args: unknown,
  context: Pick<ExecutableToolContext, 'signal' | 'onUpdate'>,
  options: McpToolOptions,
  callTool: (client: MCPClient, args: unknown, signal: AbortSignal) => Promise<MCPToolResult>,
): Promise<MCPToolResult> {
  const reconnect = options.reconnect;
  // Errors that can never be fixed by a retry: user cancellation, and the
  // server having answered — a JSON-RPC error (`McpError`, including a tool
  // call timeout) or a malformed result that failed schema validation.
  const isUnrecoverable = (e: unknown): boolean =>
    context.signal.aborted ||
    isAbortError(e) ||
    !isMcpTransportFailure(e) ||
    isMcpMalformedResultError(e);
  if (reconnect === undefined || isUnrecoverable(error)) {
    throw error;
  }

  // A ConnectionClosed error is a measured death (the SDK already fired
  // `onclose` and rejected every pending request), so it goes straight to
  // reconnect. Anything else is ambiguous about whether the transport
  // still works — probe it instead of guessing from the error's type.
  let failure = error;
  if (!isMcpConnectionClosedError(failure)) {
    const alive = await probeMcpLiveness(client, context.signal);
    context.signal.throwIfAborted();
    if (alive) {
      // The transport is fine and the failure was transient: retry once in
      // place instead of paying a full reconnect for a network blip. If the
      // transport dies between probe and retry, fall through to reconnect —
      // still capped at one reconnect per call.
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

  context.onUpdate?.({ kind: 'status', text: 'MCP connection lost — reconnecting…' });
  let freshClient: MCPClient | undefined;
  try {
    freshClient = await reconnect(context.signal);
  } catch (reconnectError) {
    if (context.signal.aborted || isAbortError(reconnectError)) {
      throw reconnectError;
    }
    throw new Error(
      `${toErrorMessage(failure)} (reconnecting the MCP server also failed: ${toErrorMessage(reconnectError)})`,
      { cause: reconnectError },
    );
  }
  if (freshClient === undefined) {
    throw failure;
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
