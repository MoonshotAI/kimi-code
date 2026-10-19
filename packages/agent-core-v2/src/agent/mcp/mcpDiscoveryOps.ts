/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
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
  agentId: z.string(),
  serverName: z.string(),
  hash: z.string(),
  tools: z.custom<readonly MCPToolDefinition[]>(),
  enabledNames: z.array(z.string()).readonly(),
  collisions: z.array(mcpToolCollisionSchema).readonly().optional(),
});

export class McpToolsDiscovered extends AgentEvent2<z.infer<typeof mcpToolsDiscoveredSchema>> {
  static override readonly type = 'mcp.tools_discovered';
  static override readonly durable = true;
  static override readonly schema = mcpToolsDiscoveredSchema;
}
export interface McpToolsDiscovered {
  readonly agentId: string;
  readonly serverName: string;
  readonly hash: string;
  readonly tools: readonly MCPToolDefinition[];
  readonly enabledNames: readonly string[];
  readonly collisions?: readonly McpToolCollision[];
}

export const mcpDiscoveryKey = defineState('mcp.discovery', (): McpDiscoveryState => ({ seen: [] }))
  .replayable({ schema: z.custom<McpDiscoveryState>() })
  .on(McpToolsDiscovered, (s, e) => {
  const key = `${e.serverName}\n${e.hash}`;
  if (s.seen.includes(key)) return;
  s.seen = [...s.seen, key];
});
