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

/** How a duplicate tool call relates to its original (dedupe telemetry). */
export type ToolCallDupType = 'same_step' | 'cross_step';

export interface IAgentToolExecutorService {
  readonly _serviceBrand: undefined;

  execute(calls: ToolCall[], options: ToolExecutorExecuteOptions): AsyncIterable<ToolExecutionResult>;

  readonly hooks: {
    readonly onBeforeExecuteTool: OrderedHookSlot<ToolBeforeExecuteContext>;
    readonly onDidExecuteTool: OrderedHookSlot<ToolDidExecuteContext>;
  };

  /**
   * Record that a tool call is a duplicate so `tool_call` telemetry can tag
   * it. Written by the `toolDedupe` plugin (which already injects this
   * service — injecting the plugin here would cycle); the executor reads and
   * clears the entry when the call's telemetry fires, defaulting to 'normal'.
   */
  recordDupType(toolCallId: string, dupType: ToolCallDupType): void;

  /**
   * Single-slot hook for the "registered but currently unavailable" preflight
   * message. A second registration overwrites the first; disposing the returned
   * handle clears the slot only when the same describer still occupies it.
   */
  registerUnavailableToolDescriber(describer: UnavailableToolDescriber): IDisposable;
  /**
   * Single-slot hook for the tool-miss preflight message (e.g. a loaded tool
   * whose server dropped). Same single-slot semantics as above.
   */
  registerMissingToolDescriber(describer: MissingToolDescriber): IDisposable;
}

export const IAgentToolExecutorService =
  createDecorator<IAgentToolExecutorService>('agentToolExecutorService');
