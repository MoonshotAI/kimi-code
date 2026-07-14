/**
 * `toolExecutor` domain (L3) — Agent-scope tool execution contract.
 *
 * Defines the public execution surface for provider tool calls, will/did
 * execution hooks, tool-call result settlement, duplicate-call tagging for
 * telemetry, and preflight description extension points. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ToolResult } from '#/tool/toolContract';
import type { ToolDidExecuteContext, ToolBeforeExecuteContext } from '#/agent/toolExecutor/toolHooks';
import type { ToolCall } from '#/app/llmProtocol/message';
import type { OrderedHookSlot } from '#/hooks';

export interface ToolCallStartedPayload {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ToolExecutorExecuteOptions {
  readonly signal: AbortSignal;
  readonly turnId: number;
  readonly onToolCall?: (payload: ToolCallStartedPayload) => void;
}

export interface ToolExecutionResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: ToolResult;
}

export type MissingToolDescriber = (toolName: string) => string | undefined;
export type UnavailableToolDescriber = (toolName: string) => string | undefined;

export type ToolCallDupType = 'same_step' | 'cross_step';

export interface IAgentToolExecutorService {
  readonly _serviceBrand: undefined;

  execute(calls: ToolCall[], options: ToolExecutorExecuteOptions): AsyncIterable<ToolExecutionResult>;

  readonly hooks: {
    readonly onBeforeExecuteTool: OrderedHookSlot<ToolBeforeExecuteContext>;
    readonly onDidExecuteTool: OrderedHookSlot<ToolDidExecuteContext>;
  };

  recordDupType(toolCallId: string, dupType: ToolCallDupType): void;

  registerUnavailableToolDescriber(describer: UnavailableToolDescriber): IDisposable;
  registerMissingToolDescriber(describer: MissingToolDescriber): IDisposable;
}

export const IAgentToolExecutorService =
  createDecorator<IAgentToolExecutorService>('agentToolExecutorService');
