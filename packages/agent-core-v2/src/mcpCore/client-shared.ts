/**
 * `mcpCore` domain (L2) — shared MCP client helpers — request options, liveness probes, result conversion.
 */

import { getCoreVersion } from '#/_base/version';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';

import {
  KimiChannelNotificationSchema,
  type MCPChannelMessage,
} from './channel-notification';
import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export const KIMI_MCP_CLIENT_NAME = 'kimi-code';
export const KIMI_MCP_CLIENT_VERSION = getCoreVersion();

export interface UnexpectedCloseReason {
  readonly error?: Error;
  readonly stderr?: string;
}

export type UnexpectedCloseListener = (reason: UnexpectedCloseReason) => void;

export function isMcpConnectionClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { readonly code?: unknown }).code === ErrorCode.ConnectionClosed
  );
}

export function isMcpTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isMcpConnectionClosedError(error)) return true;
  return !(error instanceof McpError);
}

/**
 * Timeout for the liveness probe sent after an ambiguous tool-call failure.
 * Kept short: the probe runs on an already-failed call, so it must not add
 * anywhere near a tool-call timeout to the turn.
 */
export const MCP_LIVENESS_PROBE_TIMEOUT_MS = 5_000;

/**
 * True when the error is a client-side validation failure of an otherwise
 * well-formed JSON-RPC response: the SDK rejects with a `ZodError` when the
 * result of `tools/call` does not match `CallToolResultSchema`
 * (shared/protocol.js rejects with `parseResult.error`). The server did
 * answer, so reconnecting is pointless — but the error is not an `McpError`,
 * so `isMcpTransportFailure` alone cannot tell it apart from a dead
 * transport. Matched by name because the repo carries more than one zod
 * copy, which makes `instanceof` unreliable.
 */
export function isMcpMalformedResultError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

/**
 * Probes whether the client's transport is still usable by sending a ping.
 * A server that answers in any way — including `MethodNotFound`, a JSON-RPC
 * error, or an unparseable result — counts as alive; only errors that prove
 * the bytes never made a round trip (closed connection, fetch failures) or
 * a probe that itself timed out (alive socket, unresponsive server) count
 * as dead. Never rejects; an abort surfaces as a dead verdict and is the
 * caller's job to detect via the signal.
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

export interface McpRequestOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

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

export const KIMI_CLIENT_CAPABILITIES: ClientCapabilities = {
  experimental: { channel: {} },
};

export type ChannelMessageListener = (message: MCPChannelMessage) => void;

/**
 * Buffers channel messages that arrive before a listener is attached (a real
 * possibility: `setNotificationHandler` is registered at construction time,
 * before `McpConnectionManager` gets a chance to subscribe post-connect).
 * Once a listener is set, messages deliver synchronously and any buffered
 * backlog flushes in order.
 */
export class ChannelMessageHub {
  private listener: ChannelMessageListener | undefined;
  private readonly pending: MCPChannelMessage[] = [];

  deliver(message: MCPChannelMessage): void {
    if (this.listener !== undefined) {
      this.listener(message);
      return;
    }
    this.pending.push(message);
  }

  onChannelMessage(listener: ChannelMessageListener): void {
    this.listener = listener;
    if (this.pending.length === 0) return;
    const queued = this.pending.splice(0, this.pending.length);
    for (const message of queued) listener(message);
  }
}

/**
 * Builds an MCP SDK `Client` pre-wired for the push channel: declares the
 * `experimental.channel` capability and registers a handler that forwards
 * `notifications/kimi/channel` into the returned hub. Shared by all three
 * transport wrappers (stdio / http / sse) so the wiring lives in one place.
 */
export function createMcpSdkClient(
  name: string,
  version: string,
): { client: Client; channelHub: ChannelMessageHub } {
  const client = new Client({ name, version }, { capabilities: KIMI_CLIENT_CAPABILITIES });
  const channelHub = new ChannelMessageHub();
  client.setNotificationHandler(KimiChannelNotificationSchema, (notification) => {
    channelHub.deliver({
      text: notification.params.text,
      chatId: notification.params.chatId,
    });
  });
  return { client, channelHub };
}
