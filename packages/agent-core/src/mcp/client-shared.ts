import { getCoreVersion } from '#/version';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export const KIMI_MCP_CLIENT_NAME = 'kimi-code';
// Resolved from agent-core's package.json so MCP servers see the real version
// in `initialize` (used for compatibility checks, telemetry, debugging).
// `getCoreVersion()` falls back to '0.0.0' if the package.json read fails.
export const KIMI_MCP_CLIENT_VERSION = getCoreVersion();

/**
 * Why-context attached when a runtime client notices its underlying transport
 * has gone away on its own — i.e. {@link RuntimeMcpClient.close} was NOT
 * called. The connection manager turns this into a `failed` status so the
 * UI/SDK do not keep advertising tools backed by a dead transport.
 *
 * - `error` is the last error reported via the SDK's `onerror` channel, if
 *   any. Useful for HTTP where there is no stderr.
 * - `stderr` is the tail of bytes captured from the child process's stderr;
 *   populated only for the stdio transport.
 */
export interface UnexpectedCloseReason {
  readonly error?: Error;
  readonly stderr?: string;
}

export type UnexpectedCloseListener = (reason: UnexpectedCloseReason) => void;

export interface McpRequestOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

/**
 * True when the SDK reports the connection itself as gone (the transport was
 * closed, so no in-flight request can ever complete).
 */
export function isMcpConnectionClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { readonly code?: unknown }).code === ErrorCode.ConnectionClosed
  );
}

/**
 * True when a failed tool call might recover after a reconnect: either the
 * connection is closed, or the error is a raw transport/fetch failure rather
 * than a JSON-RPC answer from the server ({@link McpError}) — reconnecting
 * would not change a server-side answer.
 */
export function isMcpTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isMcpConnectionClosedError(error)) return true;
  return !(error instanceof McpError);
}

/** Bounded so a wedged server cannot stall the reconnect decision indefinitely. */
export const MCP_LIVENESS_PROBE_TIMEOUT_MS = 5_000;

/** Response failed client-side schema validation: the server answered, so it is alive. */
export function isMcpMalformedResultError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

/**
 * Ping the server to decide whether its transport is still usable after an
 * ambiguous failure. A malformed answer still proves liveness; a timeout or
 * any transport-level failure means dead.
 */
export async function probeMcpLiveness(client: MCPClient, signal: AbortSignal): Promise<boolean> {
  try {
    await client.ping(signal);
    return true;
  } catch (error) {
    if (isMcpConnectionClosedError(error)) return false;
    if (isMcpMalformedResultError(error)) return true;
    if (error instanceof McpError) {
      return (error as Error & { readonly code?: unknown }).code !== ErrorCode.RequestTimeout;
    }
    return false;
  }
}

/**
 * Build the `RequestOptions` object accepted by MCP SDK requests, including
 * either a configured timeout, an in-flight abort signal, both, or neither.
 * Returns `undefined` when nothing needs to be passed so the SDK falls back
 * to its defaults.
 */
export function buildRequestOptions(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): McpRequestOptions | undefined {
  if (timeoutMs === undefined && signal === undefined) return undefined;
  return { timeout: timeoutMs, signal };
}

interface SdkListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export function toMcpToolDefinition(tool: SdkListedTool): MCPToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
  };
}

/**
 * Normalise the SDK's `callTool` return into kosong's {@link MCPToolResult}.
 * The SDK can return either the modern `{ content, isError }` shape or a
 * legacy `{ toolResult }` shape; we collapse the legacy shape to a single
 * text content block.
 */
export function toMcpToolResult(result: unknown): MCPToolResult {
  if (typeof result === 'object' && result !== null && 'content' in result) {
    const typed = result as {
      content: unknown;
      isError?: unknown;
      structuredContent?: unknown;
      _meta?: unknown;
    };
    if (Array.isArray(typed.content)) {
      return {
        content: typed.content as MCPToolResult['content'],
        isError: typed.isError === true,
        structuredContent: typed.structuredContent,
        _meta:
          typeof typed._meta === 'object' && typed._meta !== null
            ? (typed._meta as Record<string, unknown>)
            : undefined,
      };
    }
  }
  if (typeof result === 'object' && result !== null && 'toolResult' in result) {
    const legacy = (result as { toolResult: unknown }).toolResult;
    return {
      content: [
        {
          type: 'text',
          text: typeof legacy === 'string' ? legacy : JSON.stringify(legacy),
        },
      ],
      isError: false,
    };
  }
  return { content: [], isError: false };
}
