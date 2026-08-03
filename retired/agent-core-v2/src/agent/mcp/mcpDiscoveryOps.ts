/**
 * `mcp` domain (L5) — MCP tool-discovery wire state.
 *
 * Restores the per-agent de-dup cursor for durable MCP discovery records,
 * keyed by `${serverName}\n${hash}` entries already present in this log.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';
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

const mcpToolCollisionSchema = z.object({
  qualified: z.string(),
  toolName: z.string(),
  collidesWith: z.union([
    z.object({ kind: z.literal('same_server'), toolName: z.string() }),
    z.object({ kind: z.literal('other_server'), serverName: z.string() }),
  ]),
});

declare module '#/wire/types' {
  interface PersistedOpMap {
    'mcp.tools_discovered': typeof mcpToolsDiscovered;
  }
}

export const mcpToolsDiscovered = McpDiscoveryModel.defineOp('mcp.tools_discovered', {
  schema: z.object({
    serverName: z.string(),
    hash: z.string(),
    tools: z.custom<readonly MCPToolDefinition[]>(),
    enabledNames: z.array(z.string()).readonly(),
    collisions: z.array(mcpToolCollisionSchema).readonly().optional(),
  }),
  apply: (s, p) => {
    const key = `${p.serverName}\n${p.hash}`;
    if (s.seen.includes(key)) return s;
    return { seen: [...s.seen, key] };
  },
});
