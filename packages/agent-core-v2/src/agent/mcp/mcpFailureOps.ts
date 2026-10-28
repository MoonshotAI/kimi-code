/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

const mcpServerFailedSchema = z.object({
  agentId: z.string(),
  serverName: z.string(),
  transport: z.enum(['stdio', 'http', 'sse']),
  error: z.string().optional(),
});

export class McpServerFailed extends AgentEvent2<z.infer<typeof mcpServerFailedSchema>> {
  static override readonly type = 'mcp.server_failed';
  static override readonly durable = true;
  static override readonly schema = mcpServerFailedSchema;
}
export interface McpServerFailed {
  readonly agentId: string;
  readonly serverName: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly error?: string;
}

const mcpServerFailureResolutionSchema = z.enum(['recovered', 'needs-auth', 'disabled', 'removed']);
export type McpServerFailureResolution = z.infer<typeof mcpServerFailureResolutionSchema>;

const mcpServerFailureResolvedSchema = z.object({
  agentId: z.string(),
  serverName: z.string(),
  transport: z.enum(['stdio', 'http', 'sse']),
  resolution: mcpServerFailureResolutionSchema,
});

export class McpServerFailureResolved extends AgentEvent2<z.infer<typeof mcpServerFailureResolvedSchema>> {
  static override readonly type = 'mcp.server_failure_resolved';
  static override readonly durable = true;
  static override readonly schema = mcpServerFailureResolvedSchema;
}
export interface McpServerFailureResolved {
  readonly agentId: string;
  readonly serverName: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly resolution: McpServerFailureResolution;
}

export interface McpFailureState {
  readonly open: readonly string[];
}

export const mcpFailureKey = defineState('mcp.failures', (): McpFailureState => ({ open: [] }))
  .replayable({ schema: z.custom<McpFailureState>() })
  .on(McpServerFailed, (s, e) => {
    if (!s.open.includes(e.serverName)) s.open = [...s.open, e.serverName];
  })
  .on(McpServerFailureResolved, (s, e) => {
    s.open = s.open.filter((serverName) => serverName !== e.serverName);
  });
