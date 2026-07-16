import { getCoreVersion } from '#/_base/version';

import type { MCPToolDefinition, MCPToolResult } from './types';

export const KIMI_MCP_CLIENT_NAME = 'kimi-code';
export const KIMI_MCP_CLIENT_VERSION = getCoreVersion();

const MCP_MAX_SERIALIZED_RESULT_BYTES = 50 * 1024 * 1024;

export interface UnexpectedCloseReason {
  readonly error?: Error;
  readonly stderr?: string;
}

export type UnexpectedCloseListener = (reason: UnexpectedCloseReason) => void;

export interface McpRequestOptions {
  /** Timeout in milliseconds. */
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}

export function buildRequestOptions(
  toolCallTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): McpRequestOptions | undefined {
  if (signal?.aborted) { throw signal.reason ?? new Error('Tool call aborted'); }
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
  const serializedLength = estimateSerializedLength(result);
  if (serializedLength > MCP_MAX_SERIALIZED_RESULT_BYTES) {
    const mb = (serializedLength / (1024 * 1024)).toFixed(1);
    const limitMb = (MCP_MAX_SERIALIZED_RESULT_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(`MCP tool result too large: ~${mb} MB exceeds ${limitMb} MB limit`);
  }
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
  // Intentionally returns empty content for unrecognized result shapes —
  // the caller is expected to log the raw shape before this codepath.
  return { content: [], isError: false };
}

/**
 * Cheap upper-bound estimate of the serialized size of an MCP result
 * without paying for a full ``JSON.stringify``. We sum string lengths
 * encountered in the content array plus a fixed per-object overhead,
 * which is enough to catch the ``2 GB base64 image`` attack without
 * allocating a multi-gigabyte string.
 */
function estimateSerializedLength(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    for (const key of ['text', 'data', 'blob', 'uri']) {
      const value = record[key];
      if (typeof value === 'string') total += value.length;
    }
    const resource = record['resource'] as Record<string, unknown> | undefined;
    if (resource !== null && typeof resource === 'object') {
      for (const key of ['text', 'blob', 'uri']) {
        const value = resource[key];
        if (typeof value === 'string') total += value.length;
      }
    }
    total += 64; // per-block overhead (keys, type, mimeType, etc.)
  }
  return total;
}