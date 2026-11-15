import { getCoreVersion } from '#/_base/version';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export const KIMI_MCP_CLIENT_NAME = 'kimi-code';
export const KIMI_MCP_CLIENT_VERSION = getCoreVersion();

export interface UnexpectedCloseReason {
  readonly error?: Error;
  readonly stderr?: string;
}

export type SessionEvidence =
  | { readonly kind: 'hard'; readonly reason: UnexpectedCloseReason }
  | { readonly kind: 'weak'; readonly reason: UnexpectedCloseReason };

export type SessionEvidenceListener = (evidence: SessionEvidence) => void;

export type McpFailureKind = 'config' | 'protocol' | 'auth-static' | 'auth-oauth' | 'transport';

export class McpClassifiedStartupError extends Error {
  readonly failureKind: McpFailureKind;

  constructor(failureKind: McpFailureKind, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'McpClassifiedStartupError';
    this.failureKind = failureKind;
  }
}

export function classifyMcpDiscoveryError(error: unknown): unknown {
  const deterministic =
    (error instanceof McpError &&
      (error as Error & { readonly code?: unknown }).code === ErrorCode.MethodNotFound) ||
    isMcpMalformedResultError(error);
  if (!deterministic) return error;
  return new McpClassifiedStartupError(
    'protocol',
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

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

export const MCP_LIVENESS_PROBE_TIMEOUT_MS = 5_000;

export function isMcpMalformedResultError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

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
