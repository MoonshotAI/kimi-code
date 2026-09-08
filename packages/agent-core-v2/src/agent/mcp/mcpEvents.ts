/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { KimiErrorPayload } from '#/_base/errors/serialize';
import { AgentEvent2, type AgentDomainTrait } from '#/app/event/event2';

export interface McpServerStatusPayload {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth' | 'removed';
  readonly toolCount: number;
  readonly error?: string;
}

export interface McpServerStatusEventPayload {
  readonly agentId: string;
  readonly server: McpServerStatusPayload;
}

export class McpServerStatus extends AgentEvent2<McpServerStatusEventPayload> {
  static override readonly type = 'mcp.server.status';
  static override readonly observable = true;
}
export interface McpServerStatus extends McpServerStatusEventPayload {}

export type ToolListUpdatedReason = 'mcp.connected' | 'mcp.disconnected' | 'mcp.failed';

export interface ToolListUpdatedPayload {
  readonly agentId: string;
  readonly reason: ToolListUpdatedReason;
  readonly serverName: string;
}

export class ToolListUpdated extends AgentEvent2<ToolListUpdatedPayload> {
  static override readonly type = 'tool.list.updated';
  static override readonly observable = true;
}
export interface ToolListUpdated extends ToolListUpdatedPayload {}

export class AgentErrorEvent extends AgentEvent2<KimiErrorPayload & AgentDomainTrait> {
  static override readonly type = 'error';
  static override readonly observable = true;
}
export interface AgentErrorEvent extends KimiErrorPayload {
  readonly agentId: string;
}
