/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2, registerEvent2Class } from '#/app/event/event2';

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

registerEvent2Class(McpServerFailed);
