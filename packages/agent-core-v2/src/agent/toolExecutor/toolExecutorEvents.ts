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
import type { ToolExecutionStatus } from '#/tool/executor';
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

export interface ToolUpdatedPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly taskId: string;
  readonly status: ToolExecutionStatus;
  readonly detached: boolean;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly output?: { readonly offset: number; readonly text: string };
}

export class ToolUpdated extends AgentEvent2<ToolUpdatedPayload> {
  static override readonly type = 'tool.updated';
  static override readonly observable = true;
}
export interface ToolUpdated extends ToolUpdatedPayload {}

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

export interface ToolUpdatedEvent extends Omit<ToolUpdatedPayload, 'agentId'> {
  readonly type: 'tool.updated';
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
