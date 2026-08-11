/**
 * `toolExecutor` domain — Agent-scope tool execution contract.
 *
 * Defines the public execution surface for provider tool calls, the
 * before/will execution-interception events, the did execution hook,
 * tool-call result settlement, duplicate-call tagging for telemetry, and
 * preflight description extension points. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { ToolResult } from '#/tool/toolContract';
import type {
  BeforeToolExecuteEvent,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from '#/agent/toolExecutor/toolHooks';
import type { ToolCall } from '#/kosong/contract/message';
import type { OrderedHookSlot } from '#/hooks';
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

export type MissingToolDescriber = (toolName: string) => string | undefined;
export type UnavailableToolDescriber = (toolName: string) => string | undefined;
export type ToolCallGuard = (tool: {
  readonly name: string;
  readonly source: ToolSource;
}) => string | undefined;

export type ToolCallDupType = 'same_step' | 'cross_step';

export interface IAgentToolExecutorService {
  readonly _serviceBrand: undefined;

  execute(calls: ToolCall[], options: ToolExecutorExecuteOptions): AsyncIterable<ToolExecutionResult>;

  readonly onBeforeExecuteTool: Event<BeforeToolExecuteEvent>;

  readonly onWillExecuteTool: Event<WillExecuteToolEvent>;

  readonly hooks: {
    readonly onDidExecuteTool: OrderedHookSlot<ToolDidExecuteContext>;
  };

  recordDupType(toolCallId: string, dupType: ToolCallDupType): void;

  registerToolCallGuard(guard: ToolCallGuard): IDisposable;
  registerUnavailableToolDescriber(describer: UnavailableToolDescriber): IDisposable;
  registerMissingToolDescriber(describer: MissingToolDescriber): IDisposable;
}

export const IAgentToolExecutorService =
  createDecorator<IAgentToolExecutorService>('agentToolExecutorService');
