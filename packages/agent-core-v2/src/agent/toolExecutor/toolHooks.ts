import type { IWaitUntil } from '#/_base/event';
import type { ToolCall } from '#/kosong/contract/message';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';

import type {
  ExecutableTool,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolAccesses,
} from '#/tool/toolContract';

export interface ToolExecutionHookContext {
  readonly turnId: number;
  readonly signal: AbortSignal;
  readonly trace?: LLMRequestTrace;
  readonly toolCall: ToolCall;
  readonly toolCalls: readonly ToolCall[];
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;
}

export interface ResolvedToolExecutionHookContext extends ToolExecutionHookContext {
  readonly execution: RunnableToolExecution;
}

export interface BeforeExecuteDecision {
  readonly veto?: ExecutableToolResult;
  readonly executionMetadata?: unknown;
}

export interface BeforeToolExecuteEvent extends ResolvedToolExecutionHookContext {
  veto(result: ExecutableToolResult): void;
  allow(): void;
  pass(metadata?: unknown): void;
  waitUntil(factory: () => Promise<BeforeExecuteDecision | undefined>): void;
}

export interface WillExecuteToolEvent extends IWaitUntil {
  readonly turnId: number;
  readonly toolCall: ToolCall;
  readonly execution: RunnableToolExecution;
  readonly args: unknown;
}

export type ToolExecutionOutcome =
  | 'executed'
  | 'preflight-rejected'
  | 'resolution-failed'
  | 'vetoed'
  | 'aborted'
  | 'synthetic'
  | 'skipped';

export interface ToolDidExecuteContext extends ToolExecutionHookContext {
  readonly outcome: ToolExecutionOutcome;
  readonly accesses?: ToolAccesses;
  result: ExecutableToolResult;
  stopTurn?: boolean;
}
