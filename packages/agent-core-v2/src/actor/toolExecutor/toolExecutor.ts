import type { IDisposable } from '#/_base/di/lifecycle';
import type { ToolResult } from '#/tool/toolContract';
import type {
  BeforeToolExecuteEvent,
  ToolDidExecuteContext,
} from '#/actor/toolExecutor/toolHooks';
import type { ToolCall } from '#/kosong/contract/message';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import type { ToolSource } from '#/tool/toolContract';

export interface ToolCallStartedPayload {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ToolExecutorExecuteOptions {
  readonly signal: AbortSignal;
  readonly turnId: number;
  readonly trace?: LLMRequestTrace;
  readonly onToolCall?: (payload: ToolCallStartedPayload) => void;
}

export interface ToolExecutionResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: ToolResult;
}

export interface ActiveToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly turnId: number;
  readonly since: number;
}

export interface ToolExecutionFinishedEvent {
  readonly turnId: number;
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly result: ToolResult;
}

export type MissingToolDescriber = (toolName: string) => string | undefined;
export type UnavailableToolDescriber = (toolName: string) => string | undefined;
export type ToolCallGuard = (tool: {
  readonly name: string;
  readonly source: ToolSource;
}) => string | undefined;

export type ToolCallDupType = 'same_step' | 'cross_step';

export type ToolExecutionVetoListener = (
  event: BeforeToolExecuteEvent,
) => void | Promise<void>;

export type ToolDidExecuteHook = (
  context: ToolDidExecuteContext,
  next: (context?: ToolDidExecuteContext) => Promise<void>,
) => void | Promise<void>;

export const PERMISSION_GATE_PARTICIPANT = 'permissionGate';
export const TOOL_DEDUPE_PARTICIPANT = 'toolDedupe';

export type ToolExecutionParticipationOrder = 'prePolicy' | 'postPolicy';

export interface ToolExecutionParticipation {
  participateExecution(
    name: string,
    listener: ToolExecutionVetoListener,
    order?: ToolExecutionParticipationOrder,
  ): IDisposable;
  registerDidExecuteHook(
    name: string,
    hook: ToolDidExecuteHook,
    order?: ToolExecutionParticipationOrder,
  ): IDisposable;
  registerToolCallGuard(guard: ToolCallGuard): IDisposable;
  registerUnavailableToolDescriber(describer: UnavailableToolDescriber): IDisposable;
  registerMissingToolDescriber(describer: MissingToolDescriber): IDisposable;
}
