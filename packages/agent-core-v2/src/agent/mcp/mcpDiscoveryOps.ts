/**
 * `mcp` domain (L5) — MCP tool-discovery wire state.
 *
 * Restores the per-agent de-dup cursor for durable MCP discovery records,
 * keyed by `${serverName}\n${hash}` entries already present in this log.
 */

import { defineModel } from '#/wire/model';
import { defineOp } from '#/wire/op';
import type { MCPToolDefinition } from './types';

export interface McpToolCollision {
  readonly qualified: string;
  readonly toolName: string;
  readonly collidesWith:
    | { readonly kind: 'same_server'; readonly toolName: string }
    | { readonly kind: 'other_server'; readonly serverName: string };
}

export interface McpDiscoveryState {
  readonly seen: readonly string[];
}

export const McpDiscoveryModel = defineModel<McpDiscoveryState>('mcp.discovery', () => ({
  seen: [],
}));

export interface McpToolsDiscoveredPayload {
  readonly serverName: string;
  readonly hash: string;
  readonly tools: readonly MCPToolDefinition[];
  readonly enabledNames: readonly string[];
  readonly collisions?: readonly McpToolCollision[];
}

export const mcpToolsDiscovered = defineOp(McpDiscoveryModel, 'mcp.tools_discovered', {
  apply: (s, p: McpToolsDiscoveredPayload): McpDiscoveryState => {
    const key = `${p.serverName}\n${p.hash}`;
    if (s.seen.includes(key)) return s;
    return { seen: [...s.seen, key] };
  },
});

declare module '#/agent/wireRecord/wireRecord' {
  interface WireRecordMap {
    'mcp.tools_discovered': McpToolsDiscoveredPayload;
  }
}
