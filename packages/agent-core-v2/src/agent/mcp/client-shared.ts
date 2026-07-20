import { getCoreVersion } from '#/_base/version';

import type { MCPToolDefinition, MCPToolResult } from './types';

export const KIMI_MCP_CLIENT_NAME = 'kimi-code';
export const KIMI_MCP_CLIENT_VERSION = getCoreVersion();

export interface UnexpectedCloseReason {
  readonly error?: Error;
  readonly stderr?: string;
}

export type UnexpectedCloseListener = (reason: UnexpectedCloseReason) => void;

export interface McpRequestOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

export function buildRequestOptions(
  toolCallTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): McpRequestOptions | undefined {
  if (toolCallTimeoutMs === undefined && signal === undefined) return undefined;
  return { timeout: toolCallTimeoutMs, signal };
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
