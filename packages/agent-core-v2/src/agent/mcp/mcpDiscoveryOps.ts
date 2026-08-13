/**
 * `mcp` domain — MCP tool-discovery state.
 *
 * Restores the per-agent de-dup cursor for durable MCP discovery records,
 * keyed by `${serverName}\n${hash}` entries already present in this log. The
 * durable `mcp.tools_discovered` event (`McpToolsDiscovered`) carries the
 * discovered tool snapshot; only the cursor is folded into state.
 * Scope-agnostic.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import type { MCPToolDefinition } from '#/mcpCore/types';
import { defineState } from '#/state/state';

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

const mcpToolCollisionSchema = z.object({
  qualified: z.string(),
  toolName: z.string(),
  collidesWith: z.union([
    z.object({ kind: z.literal('same_server'), toolName: z.string() }),
    z.object({ kind: z.literal('other_server'), serverName: z.string() }),
  ]),
});

const mcpToolsDiscoveredSchema = z.object({
  serverName: z.string(),
  hash: z.string(),
  tools: z.custom<readonly MCPToolDefinition[]>(),
  enabledNames: z.array(z.string()).readonly(),
  collisions: z.array(mcpToolCollisionSchema).readonly().optional(),
});

export class McpToolsDiscovered extends Event2<z.infer<typeof mcpToolsDiscoveredSchema>> {
  static override readonly type = 'mcp.tools_discovered';
  static override readonly durable = true;
  static override readonly schema = mcpToolsDiscoveredSchema;
}
export interface McpToolsDiscovered extends z.infer<typeof mcpToolsDiscoveredSchema> {}

export const mcpDiscoveryKey = defineState('mcp.discovery', (): McpDiscoveryState => ({ seen: [] }))
  .replayable({ schema: z.custom<McpDiscoveryState>() })
  .on(McpToolsDiscovered, (s, e) => {
  const key = `${e.serverName}\n${e.hash}`;
  if (s.seen.includes(key)) return;
  s.seen = [...s.seen, key];
});
