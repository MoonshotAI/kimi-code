import { getCoreVersion } from '#/version';

import type { MCPToolDefinition, MCPToolResult } from './types';

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
    const typed = result as { content: unknown; isError?: unknown };
    if (Array.isArray(typed.content)) {
      return {
        content: typed.content as MCPToolResult['content'],
        isError: typed.isError === true,
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
