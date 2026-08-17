/**
 * `mcp` domain — the transient observable `mcp.server.status` /
 * `tool.list.updated` `Event2` classes published through the event dispatcher
 * as workspace MCP servers change state, plus the shared agent-wide `error`
 * observable (`AgentErrorEvent`, a `KimiErrorPayload` on the bus) whose type
 * string is contract-fixed for downstream consumers; this domain only owns
 * the declaration, any agent service may dispatch it.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import type { KimiErrorPayload } from '#/_base/errors/serialize';
import { Event2 } from '#/app/event/event2';

export interface McpServerStatusPayload {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth' | 'removed';
  readonly toolCount: number;
  readonly error?: string;
}

export interface McpServerStatusEventPayload {
  readonly server: McpServerStatusPayload;
}

export class McpServerStatus extends Event2<McpServerStatusEventPayload> {
  static override readonly type = 'mcp.server.status';
  static override readonly observable = true;
}
export interface McpServerStatus extends McpServerStatusEventPayload {}

export type ToolListUpdatedReason = 'mcp.connected' | 'mcp.disconnected' | 'mcp.failed';

export interface ToolListUpdatedPayload {
  readonly reason: ToolListUpdatedReason;
  readonly serverName: string;
}

export class ToolListUpdated extends Event2<ToolListUpdatedPayload> {
  static override readonly type = 'tool.list.updated';
  static override readonly observable = true;
}
export interface ToolListUpdated extends ToolListUpdatedPayload {}

export class AgentErrorEvent extends Event2<KimiErrorPayload> {
  static override readonly type = 'error';
  static override readonly observable = true;
}
export interface AgentErrorEvent extends KimiErrorPayload {}
