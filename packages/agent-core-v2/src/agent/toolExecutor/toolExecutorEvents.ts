/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { ToolCallDeltaPayload } from '#/agent/loop/turnEvents';
import type {
  McpServerStatusEventPayload,
  ToolListUpdatedPayload,
} from '#/agent/mcp/mcpEvents';
import type {
  ShellCompletedPayload,
  ShellOutputPayload,
  ShellStartedPayload,
} from '#/agent/shellCommand/shellCommandService';
import { AgentEvent2 } from '#/app/event/event2';
import type { ToolUpdate } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export interface ToolCallStartedPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly description?: string;
  readonly display?: ToolInputDisplay;
}

export class ToolCallStarted extends AgentEvent2<ToolCallStartedPayload> {
  static override readonly type = 'tool.call.started';
  static override readonly observable = true;
}
export interface ToolCallStarted extends ToolCallStartedPayload {}

export interface ToolProgressPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly update: ToolUpdate;
}

export class ToolProgress extends AgentEvent2<ToolProgressPayload> {
  static override readonly type = 'tool.progress';
  static override readonly observable = true;
}
export interface ToolProgress extends ToolProgressPayload {}

export interface ToolResultEventPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly output: unknown;
  readonly isError?: boolean;
  readonly synthetic?: boolean;
}

export class ToolResultEvent extends AgentEvent2<ToolResultEventPayload> {
  static override readonly type = 'tool.result';
  static override readonly observable = true;
}
export interface ToolResultEvent extends ToolResultEventPayload {}

export interface ToolCallDeltaEvent extends Omit<ToolCallDeltaPayload, 'agentId'> {
  readonly type: 'tool.call.delta';
}

export interface ToolCallStartedEvent extends Omit<ToolCallStartedPayload, 'agentId'> {
  readonly type: 'tool.call.started';
}

export interface ToolProgressEvent extends Omit<ToolProgressPayload, 'agentId'> {
  readonly type: 'tool.progress';
}

export interface ShellOutputEvent extends Omit<ShellOutputPayload, 'agentId'> {
  readonly type: 'shell.output';
}

export interface ShellStartedEvent extends Omit<ShellStartedPayload, 'agentId'> {
  readonly type: 'shell.started';
}

export interface ShellCompletedEvent extends Omit<ShellCompletedPayload, 'agentId'> {
  readonly type: 'shell.completed';
}

export interface ToolListUpdatedEvent extends Omit<ToolListUpdatedPayload, 'agentId'> {
  readonly type: 'tool.list.updated';
}

export interface McpServerStatusEvent extends Omit<McpServerStatusEventPayload, 'agentId'> {
  readonly type: 'mcp.server.status';
}
